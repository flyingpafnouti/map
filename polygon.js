// Polygon tool: draw a zone, then read the IGN grids inside it.
//
// - Click to add a vertex; right click, or a click on the first vertex (for
//   touch screens), closes the polygon. A click after that starts a new one.
// - On closing, the MNT (RGE ALTI) and MNS (MNS Correl) grids are fetched
//   over the polygon's bounding box from the Géoplateforme WMS-R, in tiles of
//   at most POLY_TILE x POLY_TILE cells. Cells whose centre lies inside the
//   polygon give min / max of MNT and MNS and the max of MNS - MNT, taken
//   cell by cell.
// - The step is the native 0.5 m when the bounding box fits in
//   POLY_MAX_CELLS cells, else the smallest of POLY_STEPS that fits. Only
//   0.5 x 2^k steps are used: they match the levels of the server's pyramid.
//   Other steps mix two levels and create spurious values (MNS - MNT of
//   213 m in flat Rennes at 1.5 m, against 67 m at 0.5, 1, 2, 4 and 8 m).
//   A coarser step smooths thin objects, so maxima may come out lower.
// - Cells near a gap in the data are left out (see NO_DATA_MARGIN in
//   script.js); each tile is read with that margin around it so the rule
//   holds across tile borders.
//
// Grid helpers (fetchGrid, unusableCells, the layers and constants) live in
// script.js.

const POLY_TILE = 1024;              // cells per side of one WMS request
const POLY_MAX_CELLS = 2048 * 2048;  // 16 MB per layer; 1 km² of bounding box at 0.5 m
const POLY_STEPS = [0.5, 1, 2, 4, 8]; // m; 8 m allows 268 km² of bounding box
const POLY_PARALLEL = 4;             // tiles fetched at the same time
const POLY_RETRIES = 2;              // extra attempts on a failed tile
const POLY_CLOSE_PX = 20;            // click this close to the first vertex closes
const POLY_COLOR = '#7c3aed';
const EARTH_RADIUS = 6371008.8;      // m, mean radius

// Histograms for the quartiles: 0.1 m bins from -100 m (the no-data bound)
// to 4900 m, above the highest point of France.
const HIST_MIN = -100;
const HIST_STEP = 0.1;
const HIST_BINS = 50000;

let polygonMode = false;
let polygonPoints = [];      // L.LatLng
let polygonFinished = false;
let polygonLine = null;      // outline while drawing, then the closed polygon
let polygonPreview = null;
let polygonVertices = [];
let polygonMaxMarker = null;
let polygonRequest = null;   // AbortController of the computation in flight

function togglePolygonMode() {
    polygonMode = !polygonMode;
    const btn = document.getElementById('polygonBtn');
    const mapEl = document.getElementById('map');
    if (polygonMode) {
        if (measureMode) toggleMeasureMode();
        btn.classList.add('btn-active');
        mapEl.classList.add('polygon-mode');
        map.doubleClickZoom.disable();
        map.on('mousemove', onPolygonMouseMove);
        log('⬠ Mode Polygone activé - Clic = sommet, clic droit ou premier sommet = fermer', 'success');
    } else {
        btn.classList.remove('btn-active');
        mapEl.classList.remove('polygon-mode');
        map.doubleClickZoom.enable();
        map.off('mousemove', onPolygonMouseMove);
        clearPolygon();
        log('Mode Polygone désactivé', 'info');
    }
    updateModeHint();
}

function addPolygonPoint(latlng) {
    if (polygonFinished) clearPolygon();
    if (polygonPoints.length >= 3 && isNearFirstVertex(latlng)) {
        finishPolygon();
        return;
    }
    polygonPoints.push(latlng);
    redrawPolygon();
}

function isNearFirstVertex(latlng) {
    const a = map.latLngToContainerPoint(polygonPoints[0]);
    const b = map.latLngToContainerPoint(latlng);
    return a.distanceTo(b) <= POLY_CLOSE_PX;
}

function redrawPolygon() {
    if (polygonLine) { map.removeLayer(polygonLine); polygonLine = null; }
    polygonVertices.forEach(m => map.removeLayer(m));
    polygonVertices = [];

    if (polygonFinished) {
        polygonLine = L.polygon(polygonPoints, {
            color: POLY_COLOR, weight: 2, fillOpacity: 0.12, interactive: false
        }).addTo(map);
        return;
    }
    if (polygonPoints.length >= 2) {
        polygonLine = L.polyline(polygonPoints, { color: POLY_COLOR, weight: 2, interactive: false }).addTo(map);
    }
    polygonPoints.forEach((pt, i) => {
        // The first vertex is larger: tapping it closes the polygon.
        polygonVertices.push(L.circleMarker(pt, {
            radius: i === 0 ? 7 : 4, color: POLY_COLOR, weight: 2,
            fillColor: '#fff', fillOpacity: 1, interactive: false
        }).addTo(map));
    });
}

function onPolygonMouseMove(e) {
    if (polygonPreview) { map.removeLayer(polygonPreview); polygonPreview = null; }
    if (polygonFinished || polygonPoints.length === 0) return;
    const last = polygonPoints[polygonPoints.length - 1];
    const ring = polygonPoints.length >= 2 ? [last, e.latlng, polygonPoints[0]] : [last, e.latlng];
    polygonPreview = L.polyline(ring, {
        color: POLY_COLOR, weight: 2, dashArray: '6, 6', opacity: 0.7, interactive: false
    }).addTo(map);
}

function finishPolygon() {
    if (polygonFinished) return;
    if (polygonPoints.length < 3) {
        log('⚠️ Il faut au moins 3 sommets pour fermer le polygone', 'info');
        return;
    }
    polygonFinished = true;
    if (polygonPreview) { map.removeLayer(polygonPreview); polygonPreview = null; }
    redrawPolygon();
    computePolygonStats(polygonPoints.map(p => ({ lat: p.lat, lon: p.lng })));
}

function clearPolygon() {
    if (polygonRequest) { polygonRequest.abort(); polygonRequest = null; }
    [polygonLine, polygonPreview, polygonMaxMarker, ...polygonVertices].forEach(layer => {
        if (layer) map.removeLayer(layer);
    });
    polygonLine = polygonPreview = polygonMaxMarker = null;
    polygonVertices = [];
    polygonPoints = [];
    polygonFinished = false;
}

// Area on a local tangent plane (shoelace formula); accurate for zones of a
// few kilometres.
function polygonArea(pts) {
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length * Math.PI / 180;
    const xy = pts.map(p => [
        EARTH_RADIUS * p.lon * Math.PI / 180 * Math.cos(lat0),
        EARTH_RADIUS * p.lat * Math.PI / 180
    ]);
    let twice = 0;
    for (let i = 0; i < xy.length; i++) {
        const [x1, y1] = xy[i];
        const [x2, y2] = xy[(i + 1) % xy.length];
        twice += x1 * y2 - x2 * y1;
    }
    return Math.abs(twice) / 2;
}

// Grid covering the polygon: origin at the north-west corner of its bounding
// box, step in metres (the finest of POLY_STEPS within POLY_MAX_CELLS, or
// null when even the coarsest is too fine), dLat / dLon in degrees, cols x
// rows cells.
function polygonGrid(pts) {
    const north = Math.max(...pts.map(p => p.lat));
    const south = Math.min(...pts.map(p => p.lat));
    const west = Math.min(...pts.map(p => p.lon));
    const east = Math.max(...pts.map(p => p.lon));
    const cosLat = Math.cos((north + south) / 2 * Math.PI / 180);
    const sized = step => {
        const dLat = step / M_PER_DEG_LAT;
        const dLon = step / (M_PER_DEG_LAT * cosLat);
        return {
            north, west, dLat, dLon, step,
            cols: Math.max(1, Math.ceil((east - west) / dLon)),
            rows: Math.max(1, Math.ceil((north - south) / dLat))
        };
    };
    for (const step of POLY_STEPS) {
        const grid = sized(step);
        if (grid.cols * grid.rows <= POLY_MAX_CELLS) return grid;
    }
    return { ...sized(POLY_STEPS[0]), step: null };
}

// For grid row r, the column ranges [c0, c1) whose cell centres lie inside
// the polygon (even-odd rule, so self-crossing outlines still work).
function polygonRowSpans(pts, grid, r) {
    const lat = grid.north - (r + 0.5) * grid.dLat;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if ((a.lat > lat) !== (b.lat > lat)) {
            xs.push(a.lon + (lat - a.lat) * (b.lon - a.lon) / (b.lat - a.lat));
        }
    }
    xs.sort((x, y) => x - y);
    const spans = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
        // Centre of column c: west + (c + 0.5) dLon, inside if in [x0, x1).
        const c0 = Math.max(0, Math.ceil((xs[k] - grid.west) / grid.dLon - 0.5));
        const c1 = Math.min(grid.cols, Math.ceil((xs[k + 1] - grid.west) / grid.dLon - 0.5));
        if (c1 > c0) spans.push([c0, c1]);
    }
    return spans;
}

function fetchGridRetrying(layer, bbox, w, h, signal) {
    let attempt = 0;
    const run = () => fetchGrid(layer, bbox, w, h, signal).catch(err => {
        if (signal.aborted || attempt >= POLY_RETRIES) throw err;
        attempt++;
        return new Promise(resolve => setTimeout(resolve, 500 * attempt)).then(run);
    });
    return run();
}

// Tiles of the grid that hold at least one cell inside the polygon, each with
// the spans of its rows clipped to its columns.
function polygonTiles(pts, grid) {
    const rowSpans = [];
    for (let r = 0; r < grid.rows; r++) rowSpans.push(polygonRowSpans(pts, grid, r));

    const tiles = [];
    for (let r0 = 0; r0 < grid.rows; r0 += POLY_TILE) {
        const r1 = Math.min(grid.rows, r0 + POLY_TILE);
        for (let c0 = 0; c0 < grid.cols; c0 += POLY_TILE) {
            const c1 = Math.min(grid.cols, c0 + POLY_TILE);
            const spans = [];
            let cells = 0;
            for (let r = r0; r < r1; r++) {
                for (const [a, b] of rowSpans[r]) {
                    const lo = Math.max(a, c0), hi = Math.min(b, c1);
                    if (hi > lo) { spans.push([r, lo, hi]); cells += hi - lo; }
                }
            }
            if (cells > 0) tiles.push({ r0, r1, c0, c1, spans, cells });
        }
    }
    return tiles;
}

function emptyPolygonStats() {
    return {
        cells: 0, mntCells: 0, mnsCells: 0, bothCells: 0,
        mntMin: Infinity, mntMax: -Infinity,
        mnsMin: Infinity, mnsMax: -Infinity,
        heightMin: Infinity, heightMax: -Infinity, heightMaxAt: null, heightMaxGround: null, heightMaxTop: null,
        histMnt: new Uint32Array(HIST_BINS),
        histMns: new Uint32Array(HIST_BINS),
        histHeight: new Uint32Array(HIST_BINS)
    };
}

function histBin(z) {
    return Math.min(HIST_BINS - 1, Math.max(0, Math.round((z - HIST_MIN) / HIST_STEP)));
}

// Value below which a fraction q of the counted cells lies, to 0.1 m.
function histQuantile(hist, count, q) {
    const target = q * (count - 1);
    let cumul = 0;
    for (let i = 0; i < hist.length; i++) {
        cumul += hist[i];
        if (cumul > target) return HIST_MIN + i * HIST_STEP;
    }
    return HIST_MIN + (hist.length - 1) * HIST_STEP;
}

// mnt and mns cover the tile plus NO_DATA_MARGIN cells on each side.
function accumulateTile(stats, grid, tile, mnt, mns) {
    const m = NO_DATA_MARGIN;
    const w = tile.c1 - tile.c0 + 2 * m;
    const h = tile.r1 - tile.r0 + 2 * m;
    const badT = unusableCells(mnt, w, h);
    const badS = unusableCells(mns, w, h);
    for (const [r, lo, hi] of tile.spans) {
        const rowOffset = (r - tile.r0 + m) * w - tile.c0 + m;
        for (let c = lo; c < hi; c++) {
            const i = rowOffset + c;
            const zt = mnt[i], zs = mns[i];
            const okT = !badT[i], okS = !badS[i];
            stats.cells++;
            if (okT) {
                stats.mntCells++;
                stats.histMnt[histBin(zt)]++;
                if (zt < stats.mntMin) stats.mntMin = zt;
                if (zt > stats.mntMax) stats.mntMax = zt;
            }
            if (okS) {
                stats.mnsCells++;
                stats.histMns[histBin(zs)]++;
                if (zs < stats.mnsMin) stats.mnsMin = zs;
                if (zs > stats.mnsMax) stats.mnsMax = zs;
            }
            if (okT && okS) {
                stats.bothCells++;
                const h = zs - zt;
                stats.histHeight[histBin(h)]++;
                if (h < stats.heightMin) stats.heightMin = h;
                if (h > stats.heightMax) {
                    stats.heightMax = h;
                    stats.heightMaxGround = zt;
                    stats.heightMaxTop = zs;
                    stats.heightMaxAt = {
                        lat: grid.north - (r + 0.5) * grid.dLat,
                        lon: grid.west + (c + 0.5) * grid.dLon
                    };
                }
            }
        }
    }
}

function computePolygonStats(pts) {
    const grid = polygonGrid(pts);
    if (grid.step === null) {
        const boxKm2 = grid.cols * grid.rows * GRID_STEP * GRID_STEP / 1e6;
        const coarsest = POLY_STEPS[POLY_STEPS.length - 1];
        const maxKm2 = POLY_MAX_CELLS * coarsest * coarsest / 1e6;
        const msg = `Zone trop grande : emprise de ${boxKm2.toFixed(0)} km², maximum ${maxKm2.toFixed(0)} km².`;
        log(`⚠️ ${msg}`, 'error');
        showPolygonMessage(msg, true);
        return;
    }
    const tiles = polygonTiles(pts, grid);
    const area = polygonArea(pts);
    if (tiles.length === 0) {
        const msg = 'Polygone trop petit : aucune maille de 0,5 m à l\'intérieur.';
        log(`⚠️ ${msg}`, 'error');
        showPolygonMessage(msg, true);
        return;
    }

    const controller = new AbortController();
    polygonRequest = controller;
    const signal = controller.signal;
    const m = NO_DATA_MARGIN;
    const mb = tiles.reduce((s, t) => s + (t.r1 - t.r0 + 2 * m) * (t.c1 - t.c0 + 2 * m), 0) * 4 * 2 / 1e6;
    const stepStr = `${String(grid.step).replace('.', ',')} m`;
    const progress = done => `Calcul en cours au pas de ${stepStr} : ${done}/${tiles.length} tuile(s), ~${mb.toFixed(1)} Mo à télécharger...`;
    log(`⬠ ${progress(0)}`, 'info');
    showPolygonMessage(progress(0), false);

    const stats = emptyPolygonStats();
    let next = 0, done = 0;
    const worker = () => {
        if (next >= tiles.length) return Promise.resolve();
        const tile = tiles[next++];
        const m = NO_DATA_MARGIN;
        const bbox = [
            grid.north - (tile.r1 + m) * grid.dLat, grid.west + (tile.c0 - m) * grid.dLon,
            grid.north - (tile.r0 - m) * grid.dLat, grid.west + (tile.c1 + m) * grid.dLon
        ];
        const w = tile.c1 - tile.c0 + 2 * m, h = tile.r1 - tile.r0 + 2 * m;
        return Promise.all([
            fetchGridRetrying(MNT_LAYER, bbox, w, h, signal),
            fetchGridRetrying(MNS_LAYER, bbox, w, h, signal)
        ]).then(([mnt, mns]) => {
            if (signal.aborted) return;
            accumulateTile(stats, grid, tile, mnt, mns);
            done++;
            if (tiles.length > 1) {
                log(`⬠ Tuile ${done}/${tiles.length}`, 'info');
                showPolygonMessage(progress(done), false, false);
            }
            return worker();
        });
    };

    const workers = [];
    for (let k = 0; k < Math.min(POLY_PARALLEL, tiles.length); k++) workers.push(worker());
    Promise.all(workers)
        .then(() => {
            if (signal.aborted) return;
            polygonRequest = null;
            showPolygonStats(stats, area, grid.step);
        })
        .catch(err => {
            if (signal.aborted) return;
            controller.abort(); // stop the other tiles
            polygonRequest = null;
            log(`Erreur polygone: ${err.message}`, 'error');
            showPolygonMessage(`Erreur : ${err.message}. Redessinez le polygone pour réessayer.`, true);
        });
}

// The polygon window with only a message (progress or error). With open set
// to false, the text is updated without reopening a window the user closed.
function showPolygonMessage(text, isError, open = true) {
    document.getElementById('polygonChart').replaceChildren();
    document.getElementById('polygonStats').replaceChildren();
    const p = document.createElement('p');
    p.className = isError ? 'polygon-message polygon-error' : 'polygon-message';
    p.textContent = text;
    document.getElementById('polygonNotes').replaceChildren(p);
    if (open) showModal('polygonModal');
}

function showPolygonStats(stats, area, step) {
    if (stats.mntCells === 0 && stats.mnsCells === 0) {
        log('⚠️ Aucune donnée d\'altitude dans ce polygone', 'error');
        showPolygonMessage('Aucune donnée d\'altitude dans ce polygone.', true);
        return;
    }
    const m = (z, ok) => (ok ? `${z.toFixed(1)} m` : '—');
    const hasT = stats.mntCells > 0, hasS = stats.mnsCells > 0, hasH = stats.bothCells > 0;
    const areaStr = area >= 1e6 ? `${(area / 1e6).toFixed(3)} km²`
        : area >= 1e4 ? `${(area / 1e4).toFixed(2)} ha` : `${area.toFixed(0)} m²`;
    const stat = (label, value) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`;

    document.getElementById('polygonStats').innerHTML =
        stat('MNT min', m(stats.mntMin, hasT)) +
        stat('MNT max', m(stats.mntMax, hasT)) +
        stat('MNS min', m(stats.mnsMin, hasS)) +
        stat('MNS max', m(stats.mnsMax, hasS)) +
        stat('Sursol max', m(stats.heightMax, hasH)) +
        stat('Surface', areaStr) +
        stat(`Mailles de ${String(step).replace('.', ',')} m`, stats.cells.toLocaleString('fr-FR')) +
        stat('Mailles utilisées', stats.bothCells.toLocaleString('fr-FR'));

    const notes = [];
    if (step > GRID_STEP) {
        notes.push(`Grande zone : grille lue au pas de ${step} m au lieu de 0,5 m. Les objets fins (arbres isolés, poteaux) sont lissés, les maxima peuvent être sous-estimés.`);
    }
    const missing = stats.cells - stats.bothCells;
    if (missing > 0) {
        notes.push(`${missing.toLocaleString('fr-FR')} maille(s) sans donnée MNT ou MNS ou en bord de lacune, ignorées.`);
    }
    if (hasH) {
        const at = stats.heightMaxAt;
        notes.push(`Sursol max en ${at.lat.toFixed(6)}, ${at.lon.toFixed(6)} (point violet sur la carte).`);
    }
    notes.push('Altitudes NGF-IGN69.');
    document.getElementById('polygonNotes').innerHTML = notes.map(n => `<p>${n}</p>`).join('');

    if (polygonMaxMarker) map.removeLayer(polygonMaxMarker);
    polygonMaxMarker = hasH ? L.circleMarker([stats.heightMaxAt.lat, stats.heightMaxAt.lon], {
        radius: 6, color: '#fff', weight: 2, fillColor: POLY_COLOR, fillOpacity: 1, interactive: false
    }).addTo(map) : null;

    showModal('polygonModal'); // first, so the chart can measure its width
    renderPolygonChart(document.getElementById('polygonChart'), stats);
    log(`⬠ MNT ${m(stats.mntMin, hasT)} à ${m(stats.mntMax, hasT)} · MNS ${m(stats.mnsMin, hasS)} à ${m(stats.mnsMax, hasS)} · sursol max ${m(stats.heightMax, hasH)} · ${areaStr}`, 'success');
}

// Chart of the heights, as two panels side by side, each with its own axis:
// - altitude NGF-IGN69 of the ground (MNT) and of the surface (MNS);
// - height above ground (MNS - MNT, cell by cell), which is not an altitude
//   and would mislead on the same axis.
// Each column is a box plot: line from min to max, block from the first to
// the third quartile, white tick at the median.
const CHART_HEIGHT = 270;
const CHART_TOP = 38;        // room for the panel title and the max label
const CHART_BOTTOM = 52;     // room for the min label and the two-line category
const CHART_AXIS = 44;       // tick labels on the left of each panel
const CHART_GAP = 26;        // between the two panels
const CHART_RIGHT = 8;
const CHART_COLORS = { mnt: '#eb6834', mns: '#1baf7a', height: POLY_COLOR };
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
}

function svgText(parent, x, y, text, cls, anchor = 'start') {
    const t = svgEl('text', { x, y, class: cls, 'text-anchor': anchor, 'dominant-baseline': 'middle' }, parent);
    t.textContent = text;
    return t;
}

// Tick step of 1, 2 or 5 x 10^k giving about `count` intervals over span.
function niceStep(span, count) {
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

function boxColumn(key, name, sub, hist, count, min, max) {
    return {
        key, name, sub, ok: count > 0, min, max,
        q1: count ? histQuantile(hist, count, 0.25) : null,
        median: count ? histQuantile(hist, count, 0.5) : null,
        q3: count ? histQuantile(hist, count, 0.75) : null
    };
}

function renderPolygonChart(container, stats) {
    container.replaceChildren();
    const panels = [
        {
            title: 'Altitude NGF (m)',
            cols: [
                boxColumn('mnt', 'Sol', 'MNT', stats.histMnt, stats.mntCells, stats.mntMin, stats.mntMax),
                boxColumn('mns', 'Surface', 'MNS', stats.histMns, stats.mnsCells, stats.mnsMin, stats.mnsMax)
            ].filter(c => c.ok)
        },
        {
            title: 'Sursol (m)',
            cols: [
                boxColumn('height', 'Sursol', 'MNS − MNT', stats.histHeight, stats.bothCells, stats.heightMin, stats.heightMax)
            ].filter(c => c.ok),
            zeroBased: true
        }
    ].filter(p => p.cols.length > 0);
    if (panels.length === 0) return;

    const width = Math.max(280, container.clientWidth || 600);
    const nCols = panels.reduce((n, p) => n + p.cols.length, 0);
    const colW = (width - panels.length * CHART_AXIS - (panels.length - 1) * CHART_GAP - CHART_RIGHT) / nCols;
    const plotTop = CHART_TOP, plotBottom = CHART_HEIGHT - CHART_BOTTOM;

    const svg = svgEl('svg', {
        width, height: CHART_HEIGHT, viewBox: `0 0 ${width} ${CHART_HEIGHT}`, role: 'img',
        'aria-label': 'Altitudes du MNT et du MNS, et sursol, dans le polygone'
    }, container);
    const tip = document.createElement('div');
    tip.className = 'altitude-tooltip chart-tip';
    container.appendChild(tip);

    let x = 0;
    for (const panel of panels) {
        const plotLeft = x + CHART_AXIS;
        const plotRight = plotLeft + colW * panel.cols.length;

        // Scale: rounded ticks; the height panel always shows its 0 (ground).
        let lo = Math.min(...panel.cols.map(c => c.min));
        let hi = Math.max(...panel.cols.map(c => c.max));
        if (panel.zeroBased) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
        const step = niceStep(hi - lo, 4);
        const t1 = Math.ceil(hi / step) * step;
        // The height panel starts just below its min (often a little under
        // 0, from noise) instead of a whole step lower.
        const d0 = panel.zeroBased ? lo - 0.04 * (t1 - lo) : Math.floor(lo / step) * step;
        const t0 = Math.ceil(d0 / step - 1e-9) * step;
        const y = v => plotTop + (t1 - v) / (t1 - d0) * (plotBottom - plotTop);
        const decimals = step < 1 ? 1 : 0;

        svgText(svg, x, 10, panel.title, 'chart-panel-title');
        for (let t = t0; t <= t1 + step / 2; t += step) {
            const zero = panel.zeroBased && Math.abs(t) < step / 1000;
            svgEl('line', { x1: plotLeft, x2: plotRight, y1: y(t), y2: y(t), class: zero ? 'chart-zero' : 'chart-grid' }, svg);
            svgText(svg, plotLeft - 8, y(t), t.toFixed(decimals), 'chart-tick', 'end');
        }

        panel.cols.forEach((c, i) => {
            const cx = plotLeft + colW * (i + 0.5);
            drawBoxColumn(svg, tip, c, cx, colW, y, width, plotTop, plotBottom);
        });
        x = plotRight + CHART_GAP;
    }

    const caption = document.createElement('p');
    caption.className = 'chart-caption';
    caption.textContent = 'Trait : du min au max. Bloc : moitié centrale des mailles (1er au 3e quartile), ' +
        'trait blanc : médiane. Le sursol (MNS − MNT, maille par maille) a sa propre échelle.';
    container.appendChild(caption);
}

function drawBoxColumn(svg, tip, c, cx, colW, y, width, plotTop, plotBottom) {
    const color = CHART_COLORS[c.key];
    const fmt = v => `${v.toFixed(1)} m`;
    const g = svgEl('g', {}, svg);
    const yMin = y(c.min), yMax = y(c.max);

    svgEl('line', { x1: cx, x2: cx, y1: yMax, y2: yMin, stroke: color, class: 'chart-whisker' }, g);
    for (const yy of [yMin, yMax]) {
        svgEl('line', { x1: cx - 6, x2: cx + 6, y1: yy, y2: yy, stroke: color, class: 'chart-whisker' }, g);
    }
    const yQ3 = y(c.q3), yQ1 = y(c.q1);
    const h = Math.max(4, yQ1 - yQ3);
    svgEl('rect', { x: cx - 10, y: (yQ1 + yQ3) / 2 - h / 2, width: 20, height: h, rx: 4, fill: color }, g);
    svgEl('line', { x1: cx - 10, x2: cx + 10, y1: y(c.median), y2: y(c.median), class: 'chart-median' }, g);

    // Direct labels: max above the line, min below it.
    const isHeight = c.key === 'height';
    const maxText = isHeight && c.max >= 0 ? `+${fmt(c.max)}` : fmt(c.max);
    svgText(g, cx, yMax - 12, maxText, isHeight ? 'chart-value' : 'chart-label', 'middle');
    svgText(g, cx, yMin + 13, fmt(c.min), 'chart-label', 'middle');
    svgText(svg, cx, plotBottom + 30, c.name, 'chart-category', 'middle');
    svgText(svg, cx, plotBottom + 44, c.sub, 'chart-category-sub', 'middle');

    // Hover / focus target: the whole column.
    const rows = [['max', c.max], ['3e quartile', c.q3], ['médiane', c.median], ['1er quartile', c.q1], ['min', c.min]];
    const label = `${c.name} (${c.sub})`;
    const hit = svgEl('rect', {
        x: cx - colW / 2, y: plotTop, width: colW, height: plotBottom - plotTop, class: 'chart-hit', tabindex: 0,
        'aria-label': `${label} : ${rows.map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`
    }, svg);
    const show = () => {
        tip.replaceChildren();
        const title = document.createElement('div');
        title.className = 'chart-tip-title';
        title.textContent = label;
        tip.appendChild(title);
        for (const [k, v] of rows) {
            const row = document.createElement('div');
            const b = document.createElement('b');
            b.textContent = fmt(v);
            row.append(b, ` ${k}`);
            tip.appendChild(row);
        }
        tip.style.display = 'block';
        const right = cx + colW / 2 - 8;
        const left = right + tip.offsetWidth > width ? cx - colW / 2 - tip.offsetWidth + 8 : right;
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${plotTop}px`;
        g.classList.add('chart-hover');
    };
    const hide = () => { tip.style.display = 'none'; g.classList.remove('chart-hover'); };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
}
