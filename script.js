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
let measureMode = false;
let measureFinished = false;
let measurePoints = [];
let measureLine = null;
let measurePreviewLine = null;
let measureVertexMarkers = [];

function initMap() {
    // rotate: map rotation from leaflet-rotate, driven by geoloc.js only (no
    // rotation gesture nor default compass control).
    map = L.map('map', {
        zoomControl: false,
        rotate: true, rotateControl: false, touchRotate: false, shiftKeyRotate: false
    }).setView([currentLat, currentLon], 10);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    createBasemap('openstreetmap').addTo(map);

    map.on('click', function(e) {
        if (polygonMode) {
            addPolygonPoint(e.latlng);
            return;
        }
        if (measureMode) {
            addMeasurePoint(e.latlng.lat, e.latlng.lng);
            return;
        }

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
                    color: '#f59e0b', weight: 3, dashArray: '8, 6'
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
        if (polygonMode) {
            finishPolygon();
            return;
        }
        if (measureMode) {
            finishMeasure();
            return;
        }
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

// crossOrigin: tiles are fetched in CORS mode so the service worker can cache
// them for offline use (all three servers send Access-Control-Allow-Origin).
// The IGN private WMTS is left as is: its CORS headers have not been checked.
const BASEMAPS = {
    openstreetmap: {
        label: 'OpenStreetMap',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { maxZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap contributors' }
    },
    // IGN TOP 25 map (SCAN 25 Touristique, 1:25 000) at every zoom level.
    // Only served by the Géoplateforme private WMTS, with the access key IGN
    // provides for its SCAN map layers. Native tiles exist from zoom 6 to 16:
    // the map cannot zoom out further, and Leaflet upscales tiles beyond 16.
    ign: {
        label: 'IGN TOP 25 (SCAN 25)',
        url: 'https://data.geopf.fr/private/wmts?apikey=ign_scan_ws' +
             '&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
             '&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN25TOUR&STYLE=normal&TILEMATRIXSET=PM_6_16' +
             '&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        options: { minZoom: 6, maxNativeZoom: 16, maxZoom: 19, attribution: '© IGN Géoplateforme' }
    },
    // "Carte littorale": SHOM nautical charts at sea merged with IGN maps on land,
    // multi-scale from zoom 6 to 16, public Géoplateforme WMTS (no key). Covers
    // metropolitan France and overseas territories. Not intended for navigation.
    marine: {
        label: 'Carte marine (SHOM)',
        url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
             '&LAYER=GEOGRAPHICALGRIDSYSTEMS.COASTALMAPS&STYLE=normal&TILEMATRIXSET=PM_6_16' +
             '&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        options: { minZoom: 6, maxNativeZoom: 16, maxZoom: 19, crossOrigin: true, attribution: '© SHOM, IGN Géoplateforme' }
    },
    satellite: {
        label: 'Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: { maxZoom: 19, crossOrigin: true, attribution: 'Esri' }
    }
};

function createBasemap(type) {
    const basemap = BASEMAPS[type] || BASEMAPS.openstreetmap;
    return L.tileLayer(basemap.url, basemap.options);
}

document.getElementById('mapType').addEventListener('change', function() {
    const mapType = this.value;
    map.eachLayer(function(layer) {
        if (layer instanceof L.TileLayer) map.removeLayer(layer);
    });
    createBasemap(mapType).addTo(map);
    log(`Fond de carte : ${BASEMAPS[mapType].label}`, 'info');
    document.querySelectorAll('.segmented [data-type]').forEach(b =>
        b.classList.toggle('is-active', b.dataset.type === mapType));
});

function setMapType(type) {
    const select = document.getElementById('mapType');
    if (select.value === type) return;
    select.value = type;
    select.dispatchEvent(new Event('change'));
}

// Shows which map tool is active in the floating status bar.
function updateModeHint() {
    const hints = [];
    if (headingMode) hints.push('Cap : cliquez deux points');
    if (measureMode) hints.push('Distance : clic gauche pour ajouter, clic droit pour terminer');
    if (altitudeMode) hints.push('Altitude : survolez la carte');
    if (polygonMode) hints.push('Polygone : cliquez les sommets, clic droit ou premier sommet pour fermer');
    const el = document.getElementById('modeHint');
    el.textContent = hints.join(' · ');
    el.parentElement.classList.toggle('has-mode', hints.length > 0);
}

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
    pathLine = L.polyline(latlngs, { color: '#4f46e5', weight: 4, opacity: 0.85 }).addTo(map);
    addArrowsToPath(pathLine, latlngs);

    let totalDistance = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
        totalDistance += L.latLng(waypoints[i].lat, waypoints[i].lon)
            .distanceTo(L.latLng(waypoints[i + 1].lat, waypoints[i + 1].lon));
    }

    const coordinates = waypoints.map(wp => [wp.lon, wp.lat]);
    const coordinatesString = JSON.stringify(coordinates, null, 2);

    log(`Chemin tracé - Distance totale: ${(totalDistance / 1000).toFixed(2)} km`, 'success');
    log(`📍 Liste des coordonnées [lon, lat]:`, 'info');
    log(coordinatesString, 'info');
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
            html: `<div style="transform:rotate(${angle}deg);color:#4f46e5;font-size:18px;text-align:center;line-height:20px;text-shadow:1px 1px 2px white,-1px -1px 2px white,-1px 1px 2px white,1px -1px 2px white">▲</div>`,
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
        document.getElementById('map').classList.add('heading-mode');
        log('🧭 Mode mesure de cap activé - Clic gauche sur 2 points pour mesurer', 'success');
    } else {
        document.getElementById('headingBtn').classList.remove('btn-active');
        document.getElementById('map').classList.remove('heading-mode');
        clearHeadingElements();
        log('Mode mesure de cap désactivé', 'info');
    }
    updateModeHint();
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

function toggleMeasureMode() {
    measureMode = !measureMode;
    const btn = document.getElementById('measureBtn');
    if (measureMode) {
        if (polygonMode) togglePolygonMode();
        btn.classList.add('btn-active');
        document.getElementById('map').classList.add('measure-mode');
        map.doubleClickZoom.disable();
        map.on('mousemove', onMeasureMouseMove);
        log('📏 Mode Mesure activé - Clic gauche = ajouter un point, clic droit = terminer', 'success');
    } else {
        btn.classList.remove('btn-active');
        document.getElementById('map').classList.remove('measure-mode');
        map.doubleClickZoom.enable();
        map.off('mousemove', onMeasureMouseMove);
        clearMeasure();
        log('Mode Mesure désactivé', 'info');
    }
    updateModeHint();
}

function formatDistance(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(1)} m`;
}

function measureTotalDistance() {
    let total = 0;
    for (let i = 0; i < measurePoints.length - 1; i++) {
        total += L.latLng(measurePoints[i][0], measurePoints[i][1])
            .distanceTo(L.latLng(measurePoints[i + 1][0], measurePoints[i + 1][1]));
    }
    return total;
}

function addMeasurePoint(lat, lon) {
    // Un nouveau clic après une mesure terminée démarre une nouvelle mesure
    if (measureFinished) {
        clearMeasure();
        measureFinished = false;
    }
    measurePoints.push([lat, lon]);
    redrawMeasure();
    if (measurePoints.length === 1) {
        log('📏 Premier point posé. Continuez à cliquer, clic droit pour terminer.', 'info');
    } else {
        log(`📏 Point ${measurePoints.length} - Distance totale: ${formatDistance(measureTotalDistance())}`, 'info');
    }
}

function redrawMeasure() {
    if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
    measureVertexMarkers.forEach(m => map.removeLayer(m));
    measureVertexMarkers = [];

    if (measurePoints.length >= 2) {
        measureLine = L.polyline(measurePoints, {
            color: '#ec4899', weight: 3, opacity: 0.9
        }).addTo(map);
    }

    let cumul = 0;
    measurePoints.forEach((pt, i) => {
        if (i > 0) {
            cumul += L.latLng(measurePoints[i - 1][0], measurePoints[i - 1][1])
                .distanceTo(L.latLng(pt[0], pt[1]));
        }
        const label = i === 0 ? 'Départ' : formatDistance(cumul);
        const marker = L.marker(pt, {
            icon: L.divIcon({
                className: 'measure-label',
                html: label,
                iconSize: null,
                iconAnchor: [0, -8]
            }),
            interactive: false
        }).addTo(map);
        measureVertexMarkers.push(marker);
    });
}

function onMeasureMouseMove(e) {
    if (!measureMode || measureFinished || measurePoints.length === 0) {
        hideMeasureTooltip();
        return;
    }
    const last = measurePoints[measurePoints.length - 1];
    if (measurePreviewLine) { map.removeLayer(measurePreviewLine); measurePreviewLine = null; }
    measurePreviewLine = L.polyline([last, [e.latlng.lat, e.latlng.lng]], {
        color: '#ec4899', weight: 2, dashArray: '4, 6', opacity: 0.7
    }).addTo(map);

    const segDist = L.latLng(last[0], last[1]).distanceTo(e.latlng);
    const total = measureTotalDistance() + segDist;
    showMeasureTooltip(e.containerPoint,
        `Segment: ${formatDistance(segDist)}<br><b>Total: ${formatDistance(total)}</b>`);
}

function finishMeasure() {
    if (measurePoints.length < 2) {
        log('⚠️ Ajoutez au moins 2 points pour mesurer une distance', 'info');
        return;
    }
    measureFinished = true;
    if (measurePreviewLine) { map.removeLayer(measurePreviewLine); measurePreviewLine = null; }
    hideMeasureTooltip();
    log(`📏 Mesure terminée: ${formatDistance(measureTotalDistance())} sur ${measurePoints.length} points`, 'success');
}

function clearMeasure() {
    if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
    if (measurePreviewLine) { map.removeLayer(measurePreviewLine); measurePreviewLine = null; }
    measureVertexMarkers.forEach(m => map.removeLayer(m));
    measureVertexMarkers = [];
    measurePoints = [];
    measureFinished = false;
    hideMeasureTooltip();
}

function showMeasureTooltip(containerPoint, html) {
    let tip = document.getElementById('measureTooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'measureTooltip';
        tip.className = 'altitude-tooltip';
        document.getElementById('map').appendChild(tip);
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = (containerPoint.x + 15) + 'px';
    tip.style.top = (containerPoint.y + 15) + 'px';
}

function hideMeasureTooltip() {
    const tip = document.getElementById('measureTooltip');
    if (tip) tip.style.display = 'none';
}

// IGN Géoplateforme altimetry service. Returns one elevation (m) per point,
// or null where the service has no data (it answers -99999 there).
const IGN_ALTI_URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_NO_DATA = -99999;

function fetchElevations(points) {
    const lons = points.map(p => p.lon.toFixed(6)).join('|');
    const lats = points.map(p => p.lat.toFixed(6)).join('|');
    const url = `${IGN_ALTI_URL}?lon=${lons}&lat=${lats}&resource=ign_rge_alti_wld&zonly=true`;
    return fetch(url)
        .then(response => {
            if (!response.ok) throw new Error(`service altimétrique indisponible (HTTP ${response.status})`);
            return response.json();
        })
        .then(data => {
            if (!Array.isArray(data.elevations)) throw new Error('réponse inattendue du service altimétrique');
            return data.elevations.map(z => (z <= IGN_NO_DATA ? null : Math.round(z * 10) / 10));
        });
}

// Point values of the IGN elevation grids, read from the Géoplateforme WMS-R
// as raw float32 at their native 0.5 m step:
// - MNT, bare ground: RGE ALTI;
// - MNS, surface with trees and roofs: MNS Correl (aerial stereo correlation).
// Altitudes are NGF-IGN69, in metres. Both grids are read the same way so
// that MNS - MNT (height of trees and buildings) compares like with like.
const IGN_WMS_URL = 'https://data.geopf.fr/wms-r/wms';
const MNT_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MNS_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const GRID_STEP = 0.5;        // m, native step of both grids
const M_PER_DEG_LAT = 111195; // m per degree of latitude, mean Earth radius

// Missing cells come back as -9999 (gaps in the MNS) or -99999 (outside the
// coverage). The server resamples with a cubic-like kernel and has no nearest
// neighbour option, so the cells next to a gap get spurious values: hundreds
// of metres too high on the valid side (571 m seen beside a 52 m roof), then
// anything down to -10000. Values below WMS_NO_DATA count as missing, and so
// does every cell within NO_DATA_MARGIN cells of one.
const WMS_NO_DATA = -100;
const NO_DATA_MARGIN = 2;

// Reads a w x h block of a grid over bbox [south, west, north, east] as a
// Float32Array: rows north to south, columns west to east, raw values (see
// unusableCells for missing ones).
function fetchGrid(layer, bbox, w, h, signal) {
    const params = new URLSearchParams({
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
        LAYERS: layer, STYLES: 'normal', CRS: 'EPSG:4326',
        // WMS 1.3.0 with EPSG:4326: latitude first.
        BBOX: bbox.map(v => v.toFixed(8)).join(','),
        WIDTH: String(w), HEIGHT: String(h), FORMAT: 'image/x-bil;bits=32'
    });
    return fetch(`${IGN_WMS_URL}?${params}`, { signal })
        .then(response => {
            if (!response.ok) throw new Error(`service altimétrique indisponible (HTTP ${response.status})`);
            // Errors come back as XML with a 200 status.
            if (!(response.headers.get('content-type') || '').startsWith('image/x-bil')) {
                throw new Error('réponse inattendue du service altimétrique');
            }
            return response.arrayBuffer();
        })
        .then(buffer => {
            if (buffer.byteLength !== w * h * 4) throw new Error('réponse inattendue du service altimétrique');
            // Little-endian float32; read through a DataView so the host byte
            // order does not matter.
            const view = new DataView(buffer);
            const values = new Float32Array(w * h);
            for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
            return values;
        });
}

// 1 for each cell that is missing or within NO_DATA_MARGIN cells of a
// missing one, 0 for usable cells.
function unusableCells(values, w, h) {
    const m = NO_DATA_MARGIN;
    const missing = new Uint8Array(w * h);
    for (let i = 0; i < missing.length; i++) missing[i] = values[i] < WMS_NO_DATA ? 1 : 0;
    // Square dilation, done as a row pass then a column pass.
    const rowPass = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            let hit = 0;
            for (let k = Math.max(0, c - m); k <= Math.min(w - 1, c + m) && !hit; k++) hit = missing[r * w + k];
            rowPass[r * w + c] = hit;
        }
    }
    const out = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            let hit = 0;
            for (let k = Math.max(0, r - m); k <= Math.min(h - 1, r + m) && !hit; k++) hit = rowPass[k * w + c];
            out[r * w + c] = hit;
        }
    }
    return out;
}

// Value of the cell centred on the point, read with NO_DATA_MARGIN cells
// around it to tell whether it is usable.
function fetchGridValue(layer, lat, lon, signal) {
    const n = 2 * NO_DATA_MARGIN + 1;
    const half = n / 2;
    const dLat = GRID_STEP / M_PER_DEG_LAT;
    const dLon = GRID_STEP / (M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
    const bbox = [lat - half * dLat, lon - half * dLon, lat + half * dLat, lon + half * dLon];
    return fetchGrid(layer, bbox, n, n, signal).then(values => {
        const centre = NO_DATA_MARGIN * n + NO_DATA_MARGIN;
        return unusableCells(values, n, n)[centre] ? null : values[centre];
    });
}

const round1 = z => (z === null ? null : Math.round(z * 10) / 10);

// Recent results, keyed by position rounded to about 1 m.
const surfaceCache = new Map();
const SURFACE_CACHE_SIZE = 500;

// Resolves to { mnt, mns, height } in metres, each null where data is missing.
function getSurfaceData(lat, lon, signal) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (surfaceCache.has(key)) return Promise.resolve(surfaceCache.get(key));
    return Promise.all([
        fetchGridValue(MNT_LAYER, lat, lon, signal),
        fetchGridValue(MNS_LAYER, lat, lon, signal)
    ]).then(([mnt, mns]) => {
        const height = mnt === null || mns === null ? null : mns - mnt;
        const result = { mnt: round1(mnt), mns: round1(mns), height: round1(height) };
        surfaceCache.set(key, result);
        if (surfaceCache.size > SURFACE_CACHE_SIZE) surfaceCache.delete(surfaceCache.keys().next().value);
        return result;
    });
}

let altitudeRequest = null; // AbortController of the request in flight

function cancelAltitudeRequest() {
    if (altitudeTimer) { clearTimeout(altitudeTimer); altitudeTimer = null; }
    if (altitudeRequest) { altitudeRequest.abort(); altitudeRequest = null; }
}

function toggleAltitudeMode() {
    altitudeMode = !altitudeMode;
    if (altitudeMode) {
        document.getElementById('altitudeBtn').classList.add('btn-active');
        document.getElementById('map').classList.add('altitude-mode');
        map.on('mousemove', onAltitudeMouseMove);
        map.on('mouseout', hideAltitudeTooltip);
        log('⛰️ Mode Altitude activé - Déplacez le curseur sur la carte', 'success');
    } else {
        document.getElementById('altitudeBtn').classList.remove('btn-active');
        document.getElementById('map').classList.remove('altitude-mode');
        map.off('mousemove', onAltitudeMouseMove);
        map.off('mouseout', hideAltitudeTooltip);
        hideAltitudeTooltip();
        cancelAltitudeRequest();
        log('Mode Altitude désactivé', 'info');
    }
    updateModeHint();
}

function formatSurfaceData({ mnt, mns, height }) {
    const m = z => (z === null ? '—' : `${z.toFixed(1)} m`);
    return `Sol (MNT) <b>${m(mnt)}</b><br>Surface (MNS) <b>${m(mns)}</b><br>Sursol (MNS − MNT) <b>${m(height)}</b>`;
}

function onAltitudeMouseMove(e) {
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    const point = e.containerPoint;
    const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    cancelAltitudeRequest();
    showAltitudeTooltip(point, `${coords}<br><i>altitude...</i>`);

    altitudeTimer = setTimeout(() => {
        altitudeTimer = null;
        const controller = new AbortController();
        altitudeRequest = controller;
        getSurfaceData(lat, lon, controller.signal)
            .then(data => {
                if (!altitudeMode || controller.signal.aborted) return;
                altitudeRequest = null;
                if (data.mnt === null && data.mns === null) {
                    showAltitudeTooltip(point, `${coords}<br><i>pas de donnée</i>`);
                    return;
                }
                showAltitudeTooltip(point, `${coords}<br>${formatSurfaceData(data)}`);
                const m = z => (z === null ? '—' : `${z} m`);
                log(`⛰️ MNT ${m(data.mnt)} · MNS ${m(data.mns)} · sursol ${m(data.height)} (${lat.toFixed(6)}, ${lon.toFixed(6)})`, 'info');
            })
            .catch(error => {
                if (!altitudeMode || controller.signal.aborted) return;
                altitudeRequest = null;
                showAltitudeTooltip(point, `${coords}<br><i>erreur</i>`);
                log(`Erreur altitude: ${error.message}`, 'error');
            });
    }, 150);
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

    fetchElevations(samples)
        .then(elevations => {
            if (elevations.every(z => z === null)) {
                log('⚠️ Aucune donnée d\'altitude sur ce parcours', 'error');
                return;
            }
            renderElevationProfile(samples, elevations, totalDist);
        })
        .catch(err => log(`Erreur profil altimétrique: ${err.message}`, 'error'));
}

let elevationChart = null;

function renderElevationProfile(samples, elevations, totalDist) {
    let gain = 0, loss = 0;
    // Missing values (null) are skipped: Chart.js draws them as gaps.
    for (let i = 1; i < elevations.length; i++) {
        if (elevations[i] === null || elevations[i - 1] === null) continue;
        const d = elevations[i] - elevations[i - 1];
        if (d > 0) gain += d; else loss -= d;
    }
    const valid = elevations.filter(z => z !== null);
    const minEle = Math.min(...valid);
    const maxEle = Math.max(...valid);

    const stat = (label, value) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`;
    document.getElementById('profileStats').innerHTML =
        stat('Distance', `${(totalDist / 1000).toFixed(2)} km`) +
        stat('Dénivelé +', `${gain.toFixed(0)} m`) +
        stat('Dénivelé −', `${loss.toFixed(0)} m`) +
        stat('Min / max', `${minEle.toFixed(0)} / ${maxEle.toFixed(0)} m`);

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
                borderColor: '#4f46e5',
                borderWidth: 2,
                backgroundColor: 'rgba(79, 70, 229, 0.10)',
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 4,
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
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    title: { display: true, text: 'Distance (km)', color: '#64748b' },
                    ticks: { maxTicksLimit: 10, color: '#94a3b8' },
                    grid: { display: false }
                },
                y: {
                    title: { display: true, text: 'Altitude (m)', color: '#64748b' },
                    ticks: { color: '#94a3b8' },
                    grid: { color: '#eef2f7' },
                    border: { display: false }
                }
            }
        }
    });

    log(`⛰️ Profil tracé - D+: ${gain.toFixed(0)} m, D-: ${loss.toFixed(0)} m`, 'success');
}

function clearMap() {
    if (headingMode) {
        headingMode = false;
        document.getElementById('headingBtn').classList.remove('btn-active');
        document.getElementById('map').classList.remove('heading-mode');
    }
    if (altitudeMode) toggleAltitudeMode();
    if (measureMode) toggleMeasureMode();
    if (polygonMode) togglePolygonMode();
    clearHeadingElements();
    clearMeasure();
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
    updateModeHint();
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

// Touch-only devices (phones, tablets): no hover, no right click.
const IS_TOUCH = window.matchMedia('(hover: none)').matches;

function updateWaypointList() {
    const list = document.getElementById('waypointList');
    const count = document.getElementById('waypointCount');
    count.textContent = waypoints.length;
    if (waypoints.length === 0) {
        list.innerHTML = `
            <div class="waypoint-empty">
                <i class="fas fa-location-dot"></i>
                <span>Aucun point pour l'instant.<br>${IS_TOUCH ? 'Appui long' : 'Clic droit'} sur la carte pour en ajouter.</span>
            </div>`;
        return;
    }
    list.innerHTML = waypoints.map((wp, index) => `
        <div class="waypoint-item">
            <div class="waypoint-index">${index + 1}</div>
            <div class="waypoint-info">
                <div class="waypoint-name">${wp.name}</div>
                <div class="waypoint-coords">${wp.lat.toFixed(6)}, ${wp.lon.toFixed(6)}</div>
            </div>
            <div class="waypoint-actions">
                <button class="icon-btn" title="Supprimer" onclick="deleteWaypoint(${index})">
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
        const newWidth = e.clientX - sidebar.getBoundingClientRect().left;
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

// Side panel visibility. The choice is remembered per browser; storage may be
// unavailable (private mode, blocked site data), so every access is guarded.
const SIDEBAR_STORAGE_KEY = 'sidebarCollapsed';

function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    document.getElementById('sidebar').inert = collapsed;
    document.getElementById('menuToggle').hidden = !collapsed;
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0'); } catch (e) {}
}

function initSidebarToggle() {
    let collapsed = false;
    try { collapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'; } catch (e) {}
    // Restore without animating the panel out on page load.
    document.body.classList.add('no-transition');
    setSidebarCollapsed(collapsed);
    requestAnimationFrame(() => requestAnimationFrame(() =>
        document.body.classList.remove('no-transition')));

    // "M" toggles the panel, unless the user is typing in a field.
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'm' && e.key !== 'M') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
        setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
}

document.addEventListener('DOMContentLoaded', function() {
    initMap();
    initResizeHandle();
    initSidebarToggle();
    updateWaypointList();
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

// --- Progressive Web App -------------------------------------------------

// Service workers need a secure context: HTTPS, or http://localhost.
if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .catch(err => log(`Mode hors ligne indisponible : ${err.message}`, 'error'));
    });
}

// Install button (Chrome on Android). Chrome fires beforeinstallprompt only
// when the app is installable and not installed yet; the event is kept to
// show the install dialog from our own button instead of Chrome's banner.
let installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    document.getElementById('installBtn').hidden = false;
});

window.addEventListener('appinstalled', () => {
    installPrompt = null;
    document.getElementById('installBtn').hidden = true;
    log('Application installée', 'success');
});

async function installApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    // A prompt can be shown only once: Chrome fires a new event if needed.
    installPrompt = null;
    document.getElementById('installBtn').hidden = true;
}
