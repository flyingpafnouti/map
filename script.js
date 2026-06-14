let map;
let waypoints = [];
let currentLat = 48.024376;
let currentLon = -1.746483;
let pathLine = null;
let markers = [];
let pathArrows = [];
let headingMode = false;
let headingPoints = [];
let headingLine = null;
let headingMarkers = [];
let altitudeMode = false;
let altitudeTimer = null;

function initMap() {
    map = L.map('map').setView([currentLat, currentLon], 10);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    map.on('click', function(e) {
        if (headingMode) {
            const lat = e.latlng.lat;
            const lon = e.latlng.lng;
            headingPoints.push([lat, lon]);

            if (headingPoints.length === 1) {
                if (headingLine) { map.removeLayer(headingLine); headingLine = null; }
                headingMarkers.forEach(m => map.removeLayer(m));
                headingMarkers = [];

                const startMarker = L.marker([lat, lon], {
                    icon: L.icon({
                        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
                        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                        iconSize: [25, 41], iconAnchor: [12, 41],
                        popupAnchor: [1, -34], shadowSize: [41, 41]
                    })
                }).addTo(map);
                headingMarkers = [startMarker];
                log('📍 Point A sélectionné. Cliquez pour le point B...', 'info');

            } else if (headingPoints.length === 2) {
                const startLat = headingPoints[0][0];
                const startLon = headingPoints[0][1];
                const endLat = headingPoints[1][0];
                const endLon = headingPoints[1][1];

                headingLine = L.polyline([[startLat, startLon], [endLat, endLon]], {
                    color: '#e83e8c', weight: 3, dashArray: '8, 6'
                }).addTo(map);

                const mB = L.marker([endLat, endLon], {
                    icon: L.icon({
                        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
                        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                        iconSize: [25, 41], iconAnchor: [12, 41],
                        popupAnchor: [1, -34], shadowSize: [41, 41]
                    })
                }).addTo(map);
                headingMarkers.push(mB);

                const bearingRad = calculateBearing(startLat, startLon, endLat, endLon);
                const headingDeg = (bearingRad * 180 / Math.PI + 360) % 360;
                const cardinal = getCardinalDirection(headingDeg);
                const dist = L.latLng(startLat, startLon).distanceTo(L.latLng(endLat, endLon));
                const distStr = dist >= 1000 ? `${(dist / 1000).toFixed(3)} km` : `${dist.toFixed(1)} m`;

                log(`🧭 Cap A→B: ${headingDeg.toFixed(1)}° (${cardinal}) | ${bearingRad.toFixed(4)} rad | Distance: ${distStr}`, 'success');
                headingPoints = [];
            }
            return;
        }

        currentLat = e.latlng.lat;
        currentLon = e.latlng.lng;
        updateCurrentPosition();
        log(`Position mise à jour: ${currentLat.toFixed(6)}, ${currentLon.toFixed(6)}`, 'info');
    });

    map.on('contextmenu', function(e) {
        e.originalEvent.preventDefault();
        const lat = e.latlng.lat;
        const lon = e.latlng.lng;
        const name = `Point ${waypoints.length + 1}`;
        addWaypointAt(lat, lon, name);
    });

    updateCurrentPosition();
    log('Carte initialisée - Prêt à naviguer !', 'success');
    log('💡 Clic gauche = définir position actuelle', 'info');
    log('💡 Clic droit = ajouter waypoint (mode normal)', 'info');
    log('💡 Bouton "Mesurer Cap" + 2 clics gauches = mesurer cap (0-360°)', 'info');
    log('💡 Glisser les marqueurs = déplacer les waypoints', 'info');
}

document.getElementById('mapType').addEventListener('change', function() {
    const mapType = this.value;
    map.eachLayer(function(layer) {
        if (layer instanceof L.TileLayer) map.removeLayer(layer);
    });
    if (mapType === 'satellite') {
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Esri'
        }).addTo(map);
        log('Vue satellite activée', 'info');
    } else {
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);
        log('Vue OpenStreetMap activée', 'info');
    }
});

function goToLocation() {
    const input = document.getElementById('searchLocation').value.trim();
    if (!input) { alert('Veuillez entrer une adresse ou des coordonnées'); return; }

    if (input.includes(',')) {
        const parts = input.split(',');
        if (parts.length === 2) {
            try {
                const lat = parseFloat(parts[0].trim());
                const lon = parseFloat(parts[1].trim());
                if (!isNaN(lat) && !isNaN(lon)) {
                    currentLat = lat; currentLon = lon;
                    map.setView([lat, lon], 15);
                    updateCurrentPosition();
                    log(`Navigation vers: ${lat.toFixed(6)}, ${lon.toFixed(6)}`, 'success');
                    return;
                }
            } catch (e) {}
        }
    }

    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(input)}`;
    fetch(url)
        .then(response => response.json())
        .then(data => {
            if (data && data.length > 0) {
                const result = data[0];
                currentLat = parseFloat(result.lat);
                currentLon = parseFloat(result.lon);
                map.setView([currentLat, currentLon], 15);
                updateCurrentPosition();
                log(`Navigation vers: ${result.display_name}`, 'success');
            } else {
                log('⚠️ Lieu non trouvé. Vérifiez l\'orthographe.', 'info');
            }
        })
        .catch(error => log(`Erreur de géocodage: ${error.message}`, 'error'));
}

function addWaypoint() {
    document.getElementById('waypointName').value = `Point ${waypoints.length + 1}`;
    document.getElementById('waypointCoords').value = '';
    showModal('waypointModal');
}

function confirmAddWaypoint() {
    const name = document.getElementById('waypointName').value.trim() || `Point ${waypoints.length + 1}`;
    const coords = document.getElementById('waypointCoords').value.trim();
    let lat = currentLat, lon = currentLon;

    if (coords) {
        const parts = coords.split(',');
        if (parts.length === 2) {
            try {
                lat = parseFloat(parts[0].trim());
                lon = parseFloat(parts[1].trim());
                if (isNaN(lat) || isNaN(lon)) {
                    log('⚠️ Coordonnées invalides, utilisation de la position actuelle', 'info');
                    lat = currentLat; lon = currentLon;
                }
            } catch (e) {
                log('⚠️ Format de coordonnées invalide, utilisation de la position actuelle', 'info');
                lat = currentLat; lon = currentLon;
            }
        } else {
            log('⚠️ Format incorrect, utilisation de la position actuelle', 'info');
            lat = currentLat; lon = currentLon;
        }
    }

    addWaypointAt(lat, lon, name);
    closeModal('waypointModal');
}

function addWaypointAt(lat, lon, name) {
    const waypointData = { name, lat, lon };
    waypoints.push(waypointData);

    const marker = L.marker([lat, lon], { draggable: true })
        .bindPopup(`<b>${name}</b><br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br><small>Glissez pour déplacer</small>`)
        .addTo(map);

    marker.on('dragend', function(e) {
        const newPos = e.target.getLatLng();
        const index = markers.indexOf(marker);
        if (index !== -1) {
            waypoints[index].lat = newPos.lat;
            waypoints[index].lon = newPos.lng;
            marker.setPopupContent(
                `<b>${waypoints[index].name}</b><br>Lat: ${newPos.lat.toFixed(6)}<br>Lon: ${newPos.lng.toFixed(6)}<br><small>Glissez pour déplacer</small>`
            );
            if (pathLine && waypoints.length > 1) {
                const newLatlngs = waypoints.map(wp => [wp.lat, wp.lon]);
                pathLine.setLatLngs(newLatlngs);
                addArrowsToPath(pathLine, newLatlngs);
            }
            updateWaypointList();
            log(`Waypoint "${waypoints[index].name}" déplacé vers: ${newPos.lat.toFixed(6)}, ${newPos.lng.toFixed(6)}`, 'info');
        }
    });

    marker.on('contextmenu', function(e) {
        e.originalEvent.preventDefault();
        const index = markers.indexOf(marker);
        if (index !== -1) deleteWaypoint(index);
    });

    markers.push(marker);
    updateWaypointList();
    log(`Waypoint ajouté: ${name} (${lat.toFixed(6)}, ${lon.toFixed(6)})`, 'success');
}

function drawPath() {
    if (waypoints.length < 2) {
        log('⚠️ Il faut au moins 2 waypoints pour tracer un chemin', 'info');
        return;
    }

    if (pathLine) map.removeLayer(pathLine);
    pathArrows.forEach(arrow => { if (map.hasLayer(arrow)) map.removeLayer(arrow); });
    pathArrows = [];

    const latlngs = waypoints.map(wp => [wp.lat, wp.lon]);
    pathLine = L.polyline(latlngs, { color: 'red', weight: 4, opacity: 0.8 }).addTo(map);
    addArrowsToPath(pathLine, latlngs);

    let totalDistance = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
        totalDistance += L.latLng(waypoints[i].lat, waypoints[i].lon)
            .distanceTo(L.latLng(waypoints[i + 1].lat, waypoints[i + 1].lon));
    }

    const coordinates = waypoints.map(wp => [wp.lon, wp.lat]);
    const coordinatesString = JSON.stringify(coordinates, null, 2);

    const ros2Poses = waypoints.map(wp =>
        `{pose: {position: {x: ${wp.lon.toFixed(5)}, y: ${wp.lat.toFixed(5)}, z: 0.0}}}`
    ).join(',\n    ');
    const ros2Command = `ros2 topic pub /path nav_msgs/msg/Path "{\n  header: {frame_id: 'map'},\n  poses: [\n    ${ros2Poses}\n  ]\n}" --once`;

    log(`Chemin tracé - Distance totale: ${(totalDistance / 1000).toFixed(2)} km`, 'success');
    log(`📍 Liste des coordonnées [lon, lat]:`, 'info');
    log(coordinatesString, 'info');
    log(`🤖 Commande ROS2:`, 'info');
    log(ros2Command, 'info');

    navigator.clipboard.writeText(ros2Command)
        .then(() => log('📋 Commande ROS2 copiée dans le presse-papier!', 'success'))
        .catch(() => log('⚠️ Impossible de copier automatiquement', 'info'));
}

function addArrowsToPath(polyline, latlngs) {
    pathArrows.forEach(arrow => { if (map.hasLayer(arrow)) map.removeLayer(arrow); });
    pathArrows = [];

    for (let i = 0; i < latlngs.length - 1; i++) {
        const start = L.latLng(latlngs[i][0], latlngs[i][1]);
        const end = L.latLng(latlngs[i + 1][0], latlngs[i + 1][1]);
        const midLat = (start.lat + end.lat) / 2;
        const midLng = (start.lng + end.lng) / 2;
        const angle = Math.atan2(end.lng - start.lng, end.lat - start.lat) * 180 / Math.PI;

        const arrowIcon = L.divIcon({
            html: `<div style="transform:rotate(${angle}deg);color:red;font-size:20px;text-align:center;line-height:20px;text-shadow:1px 1px 2px white,-1px -1px 2px white,-1px 1px 2px white,1px -1px 2px white">▲</div>`,
            iconSize: [20, 20], iconAnchor: [10, 10], className: 'arrow-icon'
        });

        const arrow = L.marker([midLat, midLng], { icon: arrowIcon, interactive: false }).addTo(map);
        pathArrows.push(arrow);
    }
}

function toggleHeadingMode() {
    headingMode = !headingMode;
    headingPoints = [];
    if (headingMode) {
        document.getElementById('headingBtn').classList.add('btn-active');
        document.getElementById('headingBtn').innerHTML = '<i class="fas fa-compass"></i> Mesurer Cap (Actif)';
        document.getElementById('map').classList.add('heading-mode');
        log('🧭 Mode mesure de cap activé - Clic gauche sur 2 points pour mesurer', 'success');
    } else {
        document.getElementById('headingBtn').classList.remove('btn-active');
        document.getElementById('headingBtn').innerHTML = '<i class="fas fa-compass"></i> Mesurer Cap';
        document.getElementById('map').classList.remove('heading-mode');
        clearHeadingElements();
        log('Mode mesure de cap désactivé', 'info');
    }
}

function clearHeadingElements() {
    if (headingLine) { map.removeLayer(headingLine); headingLine = null; }
    headingMarkers.forEach(m => map.removeLayer(m));
    headingMarkers = []; headingPoints = [];
}

function getCardinalDirection(deg) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    return Math.atan2(y, x);
}

function getCoordinates() {
    const coords = `${currentLat.toFixed(6)},${currentLon.toFixed(6)}`;
    navigator.clipboard.writeText(coords).then(() => {
        alert(`Coordonnées copiées: ${coords}`);
        log(`Coordonnées copiées: ${coords}`, 'info');
    });
}

function getAltitude(lat, lon) {
    const url = `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`;
    return fetch(url)
        .then(response => response.json())
        .then(data => data.results[0].elevation);
}

function toggleAltitudeMode() {
    altitudeMode = !altitudeMode;
    if (altitudeMode) {
        document.getElementById('altitudeBtn').classList.add('btn-active');
        document.getElementById('altitudeBtn').innerHTML = '<i class="fas fa-mountain"></i> Altitude (Actif)';
        document.getElementById('map').classList.add('altitude-mode');
        map.on('mousemove', onAltitudeMouseMove);
        map.on('mouseout', hideAltitudeTooltip);
        log('⛰️ Mode Altitude activé - Déplacez le curseur sur la carte', 'success');
    } else {
        document.getElementById('altitudeBtn').classList.remove('btn-active');
        document.getElementById('altitudeBtn').innerHTML = '<i class="fas fa-mountain"></i> Altitude';
        document.getElementById('map').classList.remove('altitude-mode');
        map.off('mousemove', onAltitudeMouseMove);
        map.off('mouseout', hideAltitudeTooltip);
        hideAltitudeTooltip();
        if (altitudeTimer) { clearTimeout(altitudeTimer); altitudeTimer = null; }
        log('Mode Altitude désactivé', 'info');
    }
}

function onAltitudeMouseMove(e) {
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    showAltitudeTooltip(e.containerPoint, `${lat.toFixed(5)}, ${lon.toFixed(5)}<br><i>altitude...</i>`);

    if (altitudeTimer) clearTimeout(altitudeTimer);
    altitudeTimer = setTimeout(() => {
        getAltitude(lat, lon)
            .then(elevation => {
                if (!altitudeMode) return;
                showAltitudeTooltip(e.containerPoint, `${lat.toFixed(5)}, ${lon.toFixed(5)}<br><b>⛰️ ${elevation} m</b>`);
                log(`⛰️ Altitude: ${elevation} m (${lat.toFixed(6)}, ${lon.toFixed(6)})`, 'info');
            })
            .catch(error => {
                if (!altitudeMode) return;
                showAltitudeTooltip(e.containerPoint, `${lat.toFixed(5)}, ${lon.toFixed(5)}<br><i>erreur</i>`);
                log(`Erreur altitude: ${error.message}`, 'error');
            });
    }, 400);
}

function showAltitudeTooltip(containerPoint, html) {
    let tip = document.getElementById('altitudeTooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'altitudeTooltip';
        tip.className = 'altitude-tooltip';
        document.getElementById('map').appendChild(tip);
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = (containerPoint.x + 15) + 'px';
    tip.style.top = (containerPoint.y + 15) + 'px';
}

function hideAltitudeTooltip() {
    const tip = document.getElementById('altitudeTooltip');
    if (tip) tip.style.display = 'none';
}

function showElevationProfile() {
    if (waypoints.length < 2) {
        log('⚠️ Il faut au moins 2 waypoints pour le profil altimétrique', 'info');
        return;
    }

    // Échantillonne des points le long du chemin avec leur distance cumulée
    const maxSamples = 100;
    const pts = waypoints.map(wp => L.latLng(wp.lat, wp.lon));
    let totalDist = 0;
    for (let i = 0; i < pts.length - 1; i++) totalDist += pts[i].distanceTo(pts[i + 1]);

    const samples = [{ lat: pts[0].lat, lon: pts[0].lng, dist: 0 }];
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const segDist = a.distanceTo(b);
        const steps = Math.max(1, Math.round((segDist / totalDist) * maxSamples));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            samples.push({
                lat: a.lat + (b.lat - a.lat) * t,
                lon: a.lng + (b.lng - a.lng) * t,
                dist: acc + segDist * t
            });
        }
        acc += segDist;
    }

    log(`⛰️ Calcul du profil altimétrique (${samples.length} points)...`, 'info');

    const locations = samples.map(p => `${p.lat},${p.lon}`).join('|');
    fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${locations}`)
        .then(r => r.json())
        .then(data => {
            const elevations = data.results.map(r => r.elevation);
            renderElevationProfile(samples, elevations, totalDist);
        })
        .catch(err => log(`Erreur profil altimétrique: ${err.message}`, 'error'));
}

let elevationChart = null;

function renderElevationProfile(samples, elevations, totalDist) {
    let gain = 0, loss = 0;
    for (let i = 1; i < elevations.length; i++) {
        const d = elevations[i] - elevations[i - 1];
        if (d > 0) gain += d; else loss -= d;
    }
    const minEle = Math.min(...elevations);
    const maxEle = Math.max(...elevations);

    document.getElementById('profileStats').innerHTML =
        `Distance: <b>${(totalDist / 1000).toFixed(2)} km</b> &nbsp;|&nbsp; ` +
        `D+: <b>${gain.toFixed(0)} m</b> &nbsp;|&nbsp; D-: <b>${loss.toFixed(0)} m</b> &nbsp;|&nbsp; ` +
        `Alt min/max: <b>${minEle.toFixed(0)} / ${maxEle.toFixed(0)} m</b>`;

    showModal('profileModal');

    const labels = samples.map(p => (p.dist / 1000).toFixed(2));
    const ctx = document.getElementById('profileChart').getContext('2d');
    if (elevationChart) elevationChart.destroy();
    elevationChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Altitude (m)',
                data: elevations,
                borderColor: '#795548',
                backgroundColor: 'rgba(121, 85, 72, 0.25)',
                fill: true,
                pointRadius: 0,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => `Distance: ${items[0].label} km`,
                        label: item => `Altitude: ${item.parsed.y} m`
                    }
                }
            },
            scales: {
                x: { title: { display: true, text: 'Distance (km)' }, ticks: { maxTicksLimit: 10 } },
                y: { title: { display: true, text: 'Altitude (m)' } }
            }
        }
    });

    log(`⛰️ Profil tracé - D+: ${gain.toFixed(0)} m, D-: ${loss.toFixed(0)} m`, 'success');
}

function clearMap() {
    if (headingMode) {
        headingMode = false;
        document.getElementById('headingBtn').classList.remove('btn-active');
        document.getElementById('headingBtn').innerHTML = '<i class="fas fa-compass"></i> Mesurer Cap';
        document.getElementById('map').classList.remove('heading-mode');
    }
    if (altitudeMode) toggleAltitudeMode();
    clearHeadingElements();
    waypoints = [];
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    if (pathLine) { map.removeLayer(pathLine); pathLine = null; }
    pathArrows.forEach(arrow => { if (map.hasLayer(arrow)) map.removeLayer(arrow); });
    pathArrows = [];
    const layersToRemove = [];
    map.eachLayer(function(layer) { if (!(layer instanceof L.TileLayer)) layersToRemove.push(layer); });
    layersToRemove.forEach(layer => map.removeLayer(layer));
    updateWaypointList();
    log('Carte entièrement effacée', 'info');
}

function exportData() {
    const data = { waypoints, currentPosition: [currentLat, currentLon], timestamp: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `waypoints_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log(`Données exportées (${waypoints.length} waypoints)`, 'success');
}

function importData() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                if (data.waypoints && Array.isArray(data.waypoints)) {
                    clearMap();
                    data.waypoints.forEach(wp => addWaypointAt(wp.lat, wp.lon, wp.name));
                    if (data.currentPosition) {
                        currentLat = data.currentPosition[0];
                        currentLon = data.currentPosition[1];
                        updateCurrentPosition();
                    }
                    updateWaypointList();
                    log(`Données importées (${waypoints.length} waypoints)`, 'success');
                } else {
                    throw new Error('Format de fichier invalide');
                }
            } catch (error) {
                log('Erreur lors de l\'import: ' + error.message, 'error');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function generateROS2Command() {
    if (waypoints.length === 0) {
        log('⚠️ Aucun waypoint défini. Ajoutez au moins un waypoint pour générer la commande ROS2.', 'info');
        return;
    }
    const ros2Poses = waypoints.map(wp =>
        `{pose: {position: {x: ${wp.lon.toFixed(5)}, y: ${wp.lat.toFixed(5)}, z: 0.0}}}`
    ).join(',\n    ');
    const ros2Command = `ros2 topic pub /path nav_msgs/msg/Path "{\n  header: {frame_id: 'map'},\n  poses: [\n    ${ros2Poses}\n  ]\n}" --once`;
    log(`🤖 Commande ROS2 générée:`, 'success');
    log(ros2Command, 'info');
    navigator.clipboard.writeText(ros2Command)
        .then(() => log('📋 Commande ROS2 copiée dans le presse-papier!', 'success'))
        .catch(() => log('⚠️ Impossible de copier automatiquement', 'info'));
}

function deleteWaypoint(index) {
    if (markers[index]) { map.removeLayer(markers[index]); markers.splice(index, 1); }
    const deletedName = waypoints[index].name;
    waypoints.splice(index, 1);
    if (pathLine) { map.removeLayer(pathLine); pathLine = null; }
    updateWaypointList();
    log(`Waypoint "${deletedName}" supprimé`, 'info');
}

function updateCurrentPosition() {
    document.getElementById('currentPosition').textContent = `${currentLat.toFixed(6)}, ${currentLon.toFixed(6)}`;
}

function updateWaypointList() {
    const list = document.getElementById('waypointList');
    const count = document.getElementById('waypointCount');
    count.textContent = waypoints.length;
    if (waypoints.length === 0) {
        list.innerHTML = '<div style="color:#6c757d;font-style:italic;">Aucun waypoint</div>';
        return;
    }
    list.innerHTML = waypoints.map((wp, index) => `
        <div class="waypoint-item">
            <div class="waypoint-info">
                <div class="waypoint-name">${wp.name}</div>
                <div class="waypoint-coords">${wp.lat.toFixed(6)}, ${wp.lon.toFixed(6)}</div>
            </div>
            <div class="waypoint-actions">
                <button class="btn btn-danger btn-sm" onclick="deleteWaypoint(${index})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function showModal(modalId) { document.getElementById(modalId).style.display = 'block'; }
function closeModal(modalId) { document.getElementById(modalId).style.display = 'none'; }

function log(message, type = 'info') {
    const logPanel = document.getElementById('logPanel');
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logPanel.appendChild(entry);
    logPanel.scrollTop = logPanel.scrollHeight;
}

function initResizeHandle() {
    const sidebar = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('resizeHandle');
    let isResizing = false;

    resizeHandle.addEventListener('mousedown', function(e) {
        isResizing = true;
        resizeHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!isResizing) return;
        const newWidth = e.clientX;
        const minWidth = parseInt(getComputedStyle(sidebar).minWidth);
        const maxWidth = parseInt(getComputedStyle(sidebar).maxWidth);
        if (newWidth >= minWidth && newWidth <= maxWidth) sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', function() {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('dragging');
            document.body.style.cursor = '';
            setTimeout(() => { if (map) map.invalidateSize(); }, 100);
        }
    });

    resizeHandle.addEventListener('selectstart', function(e) { e.preventDefault(); });
}

document.addEventListener('DOMContentLoaded', function() {
    initMap();
    initResizeHandle();
    log('🚀 Application chargée - Prêt à naviguer !', 'success');
    log('📋 Instructions rapides:', 'info');
    log('  • Clic gauche sur carte = changer position', 'info');
    log('  • Clic droit sur carte = ajouter waypoint', 'info');
    log('  • Bouton "Mesurer Cap" = activer mode mesure', 'info');
    log('  • Mode cap + 2 clics gauches = mesurer azimut', 'info');
    log('  • Glisser marqueur = déplacer waypoint', 'info');
    log('  • Clic droit sur marqueur = supprimer', 'info');
    log('  • Glisser bord droit panneau = redimensionner', 'info');
});

document.getElementById('searchLocation').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') goToLocation();
});

window.addEventListener('click', function(e) {
    document.querySelectorAll('.modal').forEach(modal => {
        if (e.target === modal) modal.style.display = 'none';
    });
});
