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

const GEO_SMOOTHING = 0.25;       // low-pass factor applied to the compass
const GEO_BEARING_STEP = 1;       // degrees of change before rotating the map
const GEO_CENTRED_PX = 40;        // map counts as centred within this distance
const GEO_COMPASS_TIMEOUT = 3000; // ms without compass before using GPS course

let geoWatchId = null;
let geoLatLng = null;
let geoMarker = null;
let geoAccuracy = null;
let geoCentreOnFix = false;
let geoHeading = null;            // degrees clockwise from north
let geoHeadingVec = null;         // smoothed heading as a unit vector
let geoCompassAt = 0;
let geoHeadingUp = false;
let geoRenderPending = false;

const geoOrientationEvent = 'ondeviceorientationabsolute' in window
    ? 'deviceorientationabsolute' : 'deviceorientation';

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
    window.addEventListener(geoOrientationEvent, onOrientation);
    updateGeoButtons();
    log('📡 Recherche de la position GPS...', 'info');
}

function stopTracking() {
    if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
    window.removeEventListener(geoOrientationEvent, onOrientation);
    geoWatchId = null;
    geoLatLng = null;
    geoHeading = null;
    geoHeadingVec = null;
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
        geoHeadingVec = null;
        setHeading(heading, 1);
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

function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
}

// Android Chrome: deviceorientationabsolute gives alpha, the rotation of the
// phone counterclockwise from north. Safari: webkitCompassHeading, clockwise.
// Both are relative to the top of the phone, hence the screen angle term for
// landscape use.
function onOrientation(e) {
    let h;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha !== null) h = 360 - e.alpha;
    else return;
    geoCompassAt = Date.now();
    setHeading(h + screenAngle(), GEO_SMOOTHING);
}

// Smooths on the unit circle, so that 359° and 1° average to 0°, not 180°.
function setHeading(deg, k) {
    const rad = deg * Math.PI / 180;
    const v = { x: Math.sin(rad), y: Math.cos(rad) };
    if (!geoHeadingVec) geoHeadingVec = v;
    else geoHeadingVec = {
        x: geoHeadingVec.x + k * (v.x - geoHeadingVec.x),
        y: geoHeadingVec.y + k * (v.y - geoHeadingVec.y)
    };
    const hadHeading = geoHeading !== null;
    geoHeading = (Math.atan2(geoHeadingVec.x, geoHeadingVec.y) * 180 / Math.PI + 360) % 360;
    if (!hadHeading) updateGeoButtons();

    if (!geoRenderPending) {
        geoRenderPending = true;
        requestAnimationFrame(() => {
            geoRenderPending = false;
            if (geoHeadingUp) rotateMapToHeading();
            renderHeading();
        });
    }
}

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
