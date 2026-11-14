// GPS position and phone heading, for touch devices.
//
// - Locate button: starts the GPS and centres the map on the first fix. While
//   tracking, a tap re-centres the map, or stops tracking if already centred.
// - Position: a dot with a light accuracy circle; a small arrow shows where
//   the top of the phone points (compass heading).
// - Heading-up button: rotates the map so the phone direction is up.
// - North button, shown while the map is rotated: realigns north up.
//
// Map rotation comes from leaflet-rotate: map.setBearing(b) turns the map
// content b degrees clockwise, so a direction of heading h is drawn at h + b
// on screen, and b = -h puts the phone direction up.

// Compass filter ("one euro" filter): its cutoff frequency rises with the
// turning speed, so the arrow is steady when the phone is still and follows
// without lag when it turns.
const GEO_MIN_CUTOFF = 1.5;       // Hz, cutoff when still
const GEO_SPEED_GAIN = 0.15;      // Hz added per deg/s of turning speed
const GEO_SPEED_CUTOFF = 5;       // Hz, cutoff of the turning speed estimate
const GEO_SENSOR_HZ = 60;
const GEO_BEARING_STEP = 1;       // degrees of change before rotating the map
const GEO_CENTRED_PX = 40;        // map counts as centred within this distance
const GEO_COMPASS_TIMEOUT = 3000; // ms without compass before using GPS course

let geoWatchId = null;
let geoLatLng = null;
let geoMarker = null;
let geoAccuracy = null;
let geoCentreOnFix = false;
let geoHeading = null;            // degrees clockwise from north
let geoTurnSpeed = 0;             // filtered turning speed, deg/s, signed
let geoCompassAt = 0;             // time of the last compass reading, ms
let geoSensor = null;             // AbsoluteOrientationSensor, when available
let geoCompassSource = null;      // 'sensor' or 'event', once one has answered
let geoCompassStart = 0;
let geoCompassTimer = null;
let geoReadings = 0;
let geoHeadingUp = false;
let geoRenderPending = false;

const geoOrientationEvent = 'ondeviceorientationabsolute' in window
    ? 'deviceorientationabsolute' : 'deviceorientation';
const DEG = Math.PI / 180;

const GeoControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
        const box = L.DomUtil.create('div', 'geo-controls');
        box.innerHTML = `
            <button class="geo-btn" id="northBtn" hidden title="Réaligner sur le nord" aria-label="Réaligner sur le nord">
                <span class="north-needle"></span>
            </button>
            <button class="geo-btn" id="headingUpBtn" hidden title="Orienter la carte selon le téléphone"
                    aria-label="Orienter la carte selon le téléphone">
                <i class="fas fa-compass"></i>
            </button>
            <button class="geo-btn" id="locateBtn" title="Ma position" aria-label="Ma position">
                <i class="fas fa-location-crosshairs"></i>
            </button>`;
        L.DomEvent.disableClickPropagation(box);
        box.querySelector('#locateBtn').onclick = onLocateClick;
        box.querySelector('#headingUpBtn').onclick = () => setHeadingUp(!geoHeadingUp);
        box.querySelector('#northBtn').onclick = resetNorth;
        return box;
    }
});

// --- Buttons -------------------------------------------------------------

function onLocateClick() {
    if (geoWatchId === null) { startTracking(); return; }
    if (!geoLatLng) return;  // still waiting for the first fix
    const offset = map.latLngToContainerPoint(geoLatLng).distanceTo(map.getSize().divideBy(2));
    if (offset > GEO_CENTRED_PX) map.panTo(geoLatLng);
    else stopTracking();
}

function setHeadingUp(on) {
    geoHeadingUp = on && geoHeading !== null;
    document.getElementById('headingUpBtn').classList.toggle('is-active', geoHeadingUp);
    if (geoHeadingUp) map.setBearing(-geoHeading);
}

function resetNorth() {
    setHeadingUp(false);
    map.setBearing(0);
}

function updateGeoButtons() {
    const locate = document.getElementById('locateBtn');
    locate.classList.toggle('is-active', geoWatchId !== null && !!geoLatLng);
    locate.classList.toggle('is-searching', geoWatchId !== null && !geoLatLng);
    document.getElementById('headingUpBtn').hidden = geoWatchId === null || geoHeading === null;
}

// On mobile, tile layers only load tiles at the end of a move (Leaflet's
// updateWhenIdle), and leaflet-rotate then skips them on rotation: without
// this, the corners uncovered by a rotation stay blank.
const refreshTilesAfterRotate = L.Util.throttle(() => {
    map.eachLayer(layer => {
        if (layer instanceof L.GridLayer && layer.options.updateWhenIdle) layer._onMoveEnd();
    });
}, 200);

// Keeps the north needle, its button and the heading arrow in line with the
// map rotation.
function onMapRotate() {
    refreshTilesAfterRotate();
    const bearing = map.getBearing();
    const rotated = Math.abs(((bearing + 180) % 360 + 360) % 360 - 180) > 0.5;
    const north = document.getElementById('northBtn');
    north.hidden = !rotated;
    north.querySelector('.north-needle').style.transform = `rotate(${bearing}deg)`;
    renderHeading();
}

// --- GPS -----------------------------------------------------------------

function startTracking() {
    geoCentreOnFix = true;
    geoWatchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
        enableHighAccuracy: true, maximumAge: 5000, timeout: 30000
    });
    startCompass();
    updateGeoButtons();
    log('📡 Recherche de la position GPS...', 'info');
}

function stopTracking() {
    if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
    stopCompass();
    geoWatchId = null;
    geoLatLng = null;
    geoHeading = null;
    if (geoMarker) { map.removeLayer(geoMarker); geoMarker = null; }
    if (geoAccuracy) { map.removeLayer(geoAccuracy); geoAccuracy = null; }
    setHeadingUp(false);
    updateGeoButtons();
    log('Suivi GPS arrêté', 'info');
}

function onPosition(pos) {
    const { latitude, longitude, accuracy, heading, speed } = pos.coords;
    geoLatLng = L.latLng(latitude, longitude);

    if (!geoMarker) {
        geoMarker = L.marker(geoLatLng, {
            icon: L.divIcon({
                className: 'geo-marker',
                html: '<div class="geo-arrow" hidden></div><div class="geo-dot"></div>',
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            }),
            interactive: false,
            keyboard: false,
            zIndexOffset: 1000
        });
        geoAccuracy = L.circle(geoLatLng, {
            radius: accuracy, stroke: false, fillColor: '#4f46e5', fillOpacity: 0.1, interactive: false
        });
    }
    // "Tout effacer" removes every overlay: put them back if needed.
    if (!map.hasLayer(geoAccuracy)) geoAccuracy.addTo(map);
    if (!map.hasLayer(geoMarker)) geoMarker.addTo(map);
    geoMarker.setLatLng(geoLatLng);
    geoAccuracy.setLatLng(geoLatLng).setRadius(accuracy);

    // No compass: fall back on the GPS course while moving.
    if (Date.now() - geoCompassAt > GEO_COMPASS_TIMEOUT &&
        Number.isFinite(heading) && speed > 0.5) {
        setHeading(heading, Date.now(), true);
    }

    if (geoCentreOnFix) {
        geoCentreOnFix = false;
        map.setView(geoLatLng, Math.max(map.getZoom(), 15));
        log(`📍 Position GPS : ${latitude.toFixed(6)}, ${longitude.toFixed(6)} (± ${Math.round(accuracy)} m)`, 'success');
    }
    updateGeoButtons();
    renderHeading();
}

function onPositionError(err) {
    if (err.code === err.PERMISSION_DENIED) {
        log('⚠️ Accès à la position refusé : autorisez la localisation pour ce site', 'error');
        stopTracking();
    } else if (!geoLatLng) {
        log(`⚠️ Position GPS indisponible : ${err.message}`, 'error');
    }
}

// --- Compass -------------------------------------------------------------

// Two compass sources are started together and the first one to deliver a
// heading wins, the other is stopped:
// - AbsoluteOrientationSensor (Chrome on Android), read at 60 Hz in the
//   screen frame, so landscape is handled;
// - the deviceorientationabsolute event (deviceorientation elsewhere).
// Either one may stay silent on a given phone (sensor refused, event fired
// with null values only), so waiting on one of them could leave the arrow
// hidden.
function startCompass() {
    geoCompassSource = null;
    geoReadings = 0;
    geoCompassStart = Date.now();
    clearTimeout(geoCompassTimer);
    geoCompassTimer = setTimeout(() => {
        if (geoWatchId !== null && !geoCompassSource) {
            log('⚠️ Pas de boussole : la flèche suivra le cap GPS en marchant', 'error');
        }
    }, GEO_COMPASS_TIMEOUT);

    if ('AbsoluteOrientationSensor' in window) {
        try {
            geoSensor = new AbsoluteOrientationSensor({ frequency: GEO_SENSOR_HZ, referenceFrame: 'screen' });
            geoSensor.addEventListener('reading', onSensorReading);
            geoSensor.addEventListener('error', onSensorError);
            geoSensor.start();
        } catch (e) {
            geoSensor = null;
        }
    }
    window.addEventListener(geoOrientationEvent, onOrientation);
}

function onSensorError(e) {
    if (geoSensor) { geoSensor.stop(); geoSensor = null; }
    // The sensor had won the race: fall back on the event.
    if (geoCompassSource === 'sensor') {
        geoCompassSource = null;
        if (geoWatchId !== null) window.addEventListener(geoOrientationEvent, onOrientation);
    }
    log(`Capteur d'orientation indisponible (${e.error ? e.error.name : 'erreur'})`, 'info');
}

function stopCompass() {
    if (geoSensor) { geoSensor.stop(); geoSensor = null; }
    window.removeEventListener(geoOrientationEvent, onOrientation);
    clearTimeout(geoCompassTimer);
    geoCompassSource = null;
}

// Returns false when the reading comes from the source that lost the race.
function claimCompass(source) {
    if (geoWatchId === null) return false;
    if (geoCompassSource === source) return true;
    if (geoCompassSource) return false;
    geoCompassSource = source;
    if (source === 'sensor') {
        window.removeEventListener(geoOrientationEvent, onOrientation);
    } else if (geoSensor) {
        geoSensor.stop();
        geoSensor = null;
    }
    const name = source === 'sensor' ? 'capteur d\'orientation' : `événement ${geoOrientationEvent}`;
    log(`🧭 Boussole : ${name}, première mesure après ${Date.now() - geoCompassStart} ms`, 'success');
    const counted = geoReadings;
    setTimeout(() => {
        if (geoCompassSource === source) log(`🧭 Boussole : ${Math.round((geoReadings - counted) / 2)} mesures/s`, 'info');
    }, 2000);
    return true;
}

// Heading of the direction the phone points, from the world coordinates
// (x east, y north, z up) of its screen-up axis u and screen normal n. The
// horizontal part of u - n is used: u alone vanishes when the phone is held
// upright, n alone when it lies flat; for any tilt in between both point the
// same way, so their difference never vanishes.
function headingFromAxes(u, n) {
    const east = u[0] - n[0];
    const north = u[1] - n[1];
    if (Math.hypot(east, north) < 1e-3) return null;
    return (Math.atan2(east, north) / DEG + 360) % 360;
}

function onSensorReading() {
    if (!geoSensor || !geoSensor.quaternion || !claimCompass('sensor')) return;
    const [x, y, z, w] = geoSensor.quaternion;
    // Columns 2 and 3 of the rotation matrix: screen y axis and normal.
    const u = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    const n = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    const h = headingFromAxes(u, n);
    if (h !== null) onCompassHeading(h);
}

function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
}

// alpha, beta, gamma: Z-X'-Y'' Euler angles of the phone in the world frame
// (alpha counterclockwise from north on Android's absolute event). The screen
// up axis is the phone's y axis turned by the screen angle in landscape.
// Safari gives webkitCompassHeading directly.
function onOrientation(e) {
    if (typeof e.webkitCompassHeading === 'number') {
        if (claimCompass('event')) onCompassHeading(e.webkitCompassHeading + screenAngle());
        return;
    }
    if (!e.absolute || e.alpha === null || e.beta === null || e.gamma === null) return;
    if (!claimCompass('event')) return;
    const [sA, cA] = [Math.sin(e.alpha * DEG), Math.cos(e.alpha * DEG)];
    const [sB, cB] = [Math.sin(e.beta * DEG), Math.cos(e.beta * DEG)];
    const [sG, cG] = [Math.sin(e.gamma * DEG), Math.cos(e.gamma * DEG)];
    const xAxis = [cA * cG - sA * sB * sG, sA * cG + cA * sB * sG, -cB * sG];
    const yAxis = [-sA * cB, cA * cB, sB];
    const n = [cA * sG + sA * sB * cG, sA * sG - cA * sB * cG, cB * cG];
    const [sS, cS] = [Math.sin(screenAngle() * DEG), Math.cos(screenAngle() * DEG)];
    const u = yAxis.map((v, i) => cS * v + sS * xAxis[i]);
    const h = headingFromAxes(u, n);
    if (h !== null) onCompassHeading(h);
}

function onCompassHeading(h) {
    geoReadings++;
    geoCompassAt = Date.now();
    setHeading(h, geoCompassAt, false);
}

const wrap180 = d => ((d % 360) + 540) % 360 - 180;
const lowPassGain = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

// raw: measured heading (deg), now: time (ms), direct: skip the filter.
function setHeading(raw, now, direct) {
    const hadHeading = geoHeading !== null;
    if (!hadHeading || direct) {
        geoHeading = ((raw % 360) + 360) % 360;
        geoTurnSpeed = 0;
    } else {
        const dt = Math.max(1, now - setHeading.last) / 1000;
        const delta = wrap180(raw - geoHeading);
        // Signed speed: sensor noise averages out instead of passing for a turn.
        geoTurnSpeed += lowPassGain(GEO_SPEED_CUTOFF, dt) * (delta / dt - geoTurnSpeed);
        const cutoff = GEO_MIN_CUTOFF + GEO_SPEED_GAIN * Math.abs(geoTurnSpeed);
        geoHeading = (geoHeading + lowPassGain(cutoff, dt) * delta + 360) % 360;
    }
    setHeading.last = now;
    if (!hadHeading) updateGeoButtons();

    if (!geoRenderPending) {
        geoRenderPending = true;
        requestAnimationFrame(() => {
            geoRenderPending = false;
            if (geoHeading === null) return;
            if (geoHeadingUp) rotateMapToHeading();
            renderHeading();
        });
    }
}
setHeading.last = 0;

function rotateMapToHeading() {
    const target = -geoHeading;
    const delta = ((target - map.getBearing()) % 360 + 540) % 360 - 180;
    if (Math.abs(delta) >= GEO_BEARING_STEP) map.setBearing(target);
}

function renderHeading() {
    const arrow = geoMarker && geoMarker.getElement()?.querySelector('.geo-arrow');
    if (!arrow) return;
    arrow.hidden = geoHeading === null;
    if (geoHeading !== null) arrow.style.transform = `rotate(${geoHeading + map.getBearing()}deg)`;
}

document.addEventListener('DOMContentLoaded', () => {
    if (!IS_TOUCH || !('geolocation' in navigator)) return;
    new GeoControl().addTo(map);
    map.on('rotate', onMapRotate);
});
