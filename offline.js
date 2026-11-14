// Offline IGN maps, for touch devices (Android phones and tablets).
//
// The "download" button saves the IGN SCAN 25 tiles covering the visible area
// at every native level of the layer, from 6 (coarsest) to 16 (finest). Each
// saved area gets its own Cache Storage cache, named OFFLINE_PREFIX + id, that
// also holds a JSON description of the area under OFFLINE_META_URL. The
// service worker looks IGN tiles up in these caches before the network, and
// never deletes them on update: only the user does, from the offline panel.

const OFFLINE_PREFIX = 'ign-pack-';
const OFFLINE_META_URL = new URL('offline-pack-meta.json', location.href).href;
const OFFLINE_MIN_ZOOM = 6;
const OFFLINE_MAX_ZOOM = 16;
const OFFLINE_MAX_TILES = 12000;
const OFFLINE_TILE_BYTES = 22000;   // average SCAN 25 JPEG tile, measured
const OFFLINE_CONCURRENCY = 4;
const OFFLINE_META_EVERY = 200;     // tiles between two progress saves

let offlineJob = null;
let offlinePreview = null;
let offlineThumbUrls = [];

const offlineAvailable = () => IS_TOUCH && 'caches' in window;

function ignTileUrl(z, x, y) {
    return L.Util.template(BASEMAPS.ign.url, { z, x, y });
}

// Tile index ranges covering `bounds` at each IGN level.
function offlineTileRanges(bounds) {
    const ranges = [];
    for (let z = OFFLINE_MIN_ZOOM; z <= OFFLINE_MAX_ZOOM; z++) {
        const last = 2 ** z - 1;
        const clamp = v => Math.min(last, Math.max(0, Math.floor(v)));
        const nw = map.project(bounds.getNorthWest(), z).divideBy(256);
        const se = map.project(bounds.getSouthEast(), z).divideBy(256);
        ranges.push({ z, x0: clamp(nw.x), x1: clamp(se.x), y0: clamp(nw.y), y1: clamp(se.y) });
    }
    return ranges;
}

function countTiles(ranges) {
    return ranges.reduce((n, r) => n + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0);
}

function* tileUrls(ranges) {
    for (const r of ranges)
        for (let x = r.x0; x <= r.x1; x++)
            for (let y = r.y0; y <= r.y1; y++) yield ignTileUrl(r.z, x, y);
}

// Thumbnail: the tile holding the centre of the area, at the finest level
// where the whole area still fits in a 2 x 2 block of tiles.
function thumbnailUrl(bounds, ranges) {
    let pick = ranges[0];
    for (const r of ranges) if (r.x1 - r.x0 <= 1 && r.y1 - r.y0 <= 1) pick = r;
    const c = map.project(bounds.getCenter(), pick.z).divideBy(256);
    return ignTileUrl(pick.z, Math.floor(c.x), Math.floor(c.y));
}

function formatBytes(bytes) {
    if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} ko`;
    if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} Mo`;
    return `${(bytes / 1e9).toFixed(1)} Go`;
}

const formatCount = n => n.toLocaleString('fr-FR');

function writeMeta(cache, meta) {
    return cache.put(OFFLINE_META_URL, new Response(JSON.stringify(meta), {
        headers: { 'Content-Type': 'application/json' }
    }));
}

async function readPacks() {
    const names = (await caches.keys()).filter(n => n.startsWith(OFFLINE_PREFIX));
    const packs = await Promise.all(names.map(async cacheName => {
        const cache = await caches.open(cacheName);
        const res = await cache.match(OFFLINE_META_URL);
        const meta = res ? await res.json().catch(() => null) : null;
        return { cacheName, cache, meta };
    }));
    return packs.sort((a, b) => (b.meta?.created || '').localeCompare(a.meta?.created || ''));
}

// --- Panel -----------------------------------------------------------------

function openOfflineModal() {
    if (offlinePreview) { map.removeLayer(offlinePreview); offlinePreview = null; }
    if (!offlineJob) {
        document.getElementById('offlineName').value =
            `Carte du ${new Date().toLocaleDateString('fr-FR')}`;
    }
    renderOfflineEstimate();
    renderOfflineList();
    showModal('offlineModal');
}

function renderOfflineEstimate() {
    const total = countTiles(offlineTileRanges(map.getBounds()));
    const tooBig = total > OFFLINE_MAX_TILES;
    const stat = (label, value) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`;
    document.getElementById('offlineEstimate').innerHTML =
        stat('Niveaux', `${OFFLINE_MIN_ZOOM} à ${OFFLINE_MAX_ZOOM}`) +
        stat('Tuiles', formatCount(total)) +
        stat('Taille', `~${formatBytes(total * OFFLINE_TILE_BYTES)}`);
    const warn = document.getElementById('offlineWarning');
    warn.hidden = !tooBig;
    warn.textContent = tooBig
        ? `Zone trop grande (plus de ${formatCount(OFFLINE_MAX_TILES)} tuiles) : zoomez sur la carte.`
        : '';
    document.getElementById('offlineStart').disabled = tooBig || !!offlineJob;
}

function renderOfflineProgress() {
    const box = document.getElementById('offlineProgress');
    const busy = !!offlineJob;
    box.hidden = !busy;
    document.getElementById('offlineStart').hidden = busy;
    document.getElementById('offlineCancel').hidden = !busy;
    document.getElementById('offlineName').disabled = busy;
    const fab = document.getElementById('offlineBtn');
    fab.classList.toggle('is-busy', busy);
    if (!busy) { fab.title = 'Cartes hors ligne'; return; }

    const { done, total, missing, failed, bytes } = offlineJob;
    const pct = Math.floor((100 * done) / total);
    document.getElementById('offlineProgressBar').style.width = `${pct}%`;
    let text = `${formatCount(done)} / ${formatCount(total)} tuiles · ${formatBytes(bytes)}`;
    if (failed) text += ` · ${formatCount(failed)} en échec`;
    if (missing) text += ` · ${formatCount(missing)} hors couverture`;
    document.getElementById('offlineProgressText').textContent = text;
    fab.title = `Téléchargement : ${pct} %`;
}

let offlineListToken = 0;

// Renders can overlap (each one awaits the caches): only the latest one is
// committed, and the thumbnails of the others are released.
async function renderOfflineList() {
    const token = ++offlineListToken;
    const packs = await readPacks();
    const thumbUrls = [];
    const items = [];
    for (const { cacheName, cache, meta } of packs) {
        items.push(await offlineListItem(cacheName, cache, meta, thumbUrls));
    }
    if (token !== offlineListToken) { thumbUrls.forEach(URL.revokeObjectURL); return; }

    offlineThumbUrls.forEach(URL.revokeObjectURL);
    offlineThumbUrls = thumbUrls;
    document.getElementById('offlineCount').textContent = packs.length;
    document.getElementById('offlineClearAll').disabled = packs.length === 0;
    const list = document.getElementById('offlineList');
    if (items.length) {
        list.replaceChildren(...items);
    } else {
        list.innerHTML = `
            <div class="waypoint-empty">
                <i class="fas fa-cloud-arrow-down"></i>
                <span>Aucune carte enregistrée.</span>
            </div>`;
    }
    renderOfflineStorage();
}

async function offlineListItem(cacheName, cache, meta, thumbUrls) {
    const item = document.createElement('div');
    item.className = 'offline-item';
    const running = offlineJob && offlineJob.cacheName === cacheName;

    const thumb = document.createElement('div');
    thumb.className = 'offline-thumb';
    const thumbRes = meta?.thumb ? await cache.match(meta.thumb) : null;
    if (thumbRes) {
        const url = URL.createObjectURL(await thumbRes.blob());
        thumbUrls.push(url);
        thumb.style.backgroundImage = `url("${url}")`;
    } else {
        thumb.innerHTML = '<i class="fas fa-map"></i>';
    }

    const info = document.createElement('div');
    info.className = 'offline-info';
    const name = document.createElement('div');
    name.className = 'waypoint-name';
    name.textContent = meta?.name || 'Carte sans description';
    const details = document.createElement('div');
    details.className = 'offline-details';
    if (meta) {
        const date = new Date(meta.created).toLocaleDateString('fr-FR');
        // Counts of a running download are shown by the progress bar.
        details.textContent = running ? date
            : `${date} · ${formatCount(meta.saved)} tuiles · ${formatBytes(meta.bytes)}`;
        if (running) {
            details.innerHTML += ' <span class="offline-tag">en cours</span>';
        } else if (!meta.complete) {
            details.innerHTML += ' <span class="offline-tag offline-tag-warn">incomplète</span>';
        } else if (meta.failed) {
            details.innerHTML += ` <span class="offline-tag offline-tag-warn">${formatCount(meta.failed)} manquantes</span>`;
        }
    }
    info.append(name, details);

    const actions = document.createElement('div');
    actions.className = 'waypoint-actions';
    if (meta) {
        const view = document.createElement('button');
        view.className = 'icon-btn';
        view.title = 'Voir sur la carte';
        view.innerHTML = '<i class="fas fa-eye"></i>';
        view.onclick = () => showOfflinePack(meta);
        actions.appendChild(view);
    }
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = 'Supprimer';
    del.innerHTML = '<i class="fas fa-trash"></i>';
    del.disabled = running;
    del.onclick = () => deleteOfflinePack(cacheName, meta?.name);
    actions.appendChild(del);

    item.append(thumb, info, actions);
    return item;
}

async function renderOfflineStorage() {
    const el = document.getElementById('offlineStorage');
    if (!navigator.storage?.estimate) { el.textContent = ''; return; }
    try {
        const { usage, quota } = await navigator.storage.estimate();
        const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        el.textContent = `Stockage de l'app : ${formatBytes(usage)} sur ${formatBytes(quota)} disponibles` +
            (persisted ? ' · protégé du nettoyage automatique' : '');
    } catch (e) {
        el.textContent = '';
    }
}

function showOfflinePack(meta) {
    closeModal('offlineModal');
    setMapType('ign');
    const bounds = L.latLngBounds(meta.bounds);
    if (offlinePreview) map.removeLayer(offlinePreview);
    offlinePreview = L.rectangle(bounds, {
        color: '#4f46e5', weight: 2, dashArray: '6, 6', fill: false, interactive: false
    }).addTo(map);
    map.fitBounds(bounds);
}

async function deleteOfflinePack(cacheName, name) {
    if (!confirm(`Supprimer la carte « ${name || 'sans nom'} » ?`)) return;
    await caches.delete(cacheName);
    log(`Carte hors ligne supprimée : ${name || cacheName}`, 'info');
    renderOfflineList();
}

async function clearOfflinePacks() {
    if (!confirm('Supprimer toutes les cartes enregistrées ?')) return;
    const names = (await caches.keys()).filter(n => n.startsWith(OFFLINE_PREFIX));
    const keep = offlineJob ? offlineJob.cacheName : null;
    await Promise.all(names.filter(n => n !== keep).map(n => caches.delete(n)));
    log('Cartes hors ligne supprimées', 'info');
    renderOfflineList();
}

// --- Download --------------------------------------------------------------

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

// Resolves to the tile response, 'missing' when IGN has no data there (404,
// e.g. at sea), or null after repeated failures. Throws when aborted.
async function fetchTile(url, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const res = await fetch(url, { mode: 'cors', signal });
            if (res.ok) return res;
            if (res.status === 404) return 'missing';
            if (res.status !== 429 && res.status < 500) return null;
        } catch (e) {
            if (signal.aborted) throw e;
        }
        await sleep(1000 * 2 ** attempt, signal);
    }
    return null;
}

async function startOfflineDownload() {
    if (offlineJob) return;
    const bounds = map.getBounds();
    const ranges = offlineTileRanges(bounds);
    const total = countTiles(ranges);
    if (total > OFFLINE_MAX_TILES) return;

    const id = Date.now().toString(36);
    const cacheName = OFFLINE_PREFIX + id;
    const meta = {
        id,
        name: document.getElementById('offlineName').value.trim() || `Carte ${id}`,
        created: new Date().toISOString(),
        bounds: [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]],
        minZoom: OFFLINE_MIN_ZOOM,
        maxZoom: OFFLINE_MAX_ZOOM,
        thumb: thumbnailUrl(bounds, ranges),
        total, saved: 0, missing: 0, failed: 0, bytes: 0, complete: false
    };

    let cache;
    try {
        cache = await caches.open(cacheName);
        await writeMeta(cache, meta);
    } catch (e) {
        log(`Enregistrement hors ligne impossible : ${e.message}`, 'error');
        return;
    }
    // Without this, the browser may evict the maps when storage runs low.
    try { await navigator.storage?.persist?.(); } catch (e) {}

    const controller = new AbortController();
    offlineJob = { cacheName, controller, total, done: 0, missing: 0, failed: 0, bytes: 0, wakeLock: null };
    const job = offlineJob;
    await acquireWakeLock();
    window.addEventListener('beforeunload', warnBeforeUnload);
    renderOfflineProgress();
    renderOfflineList();
    log(`Téléchargement hors ligne : ${formatCount(total)} tuiles IGN (niveaux ${OFFLINE_MIN_ZOOM} à ${OFFLINE_MAX_ZOOM})`, 'info');

    const urls = tileUrls(ranges);
    let error = null;
    const worker = async () => {
        for (const url of urls) {
            if (error || controller.signal.aborted) return;
            try {
                const res = await fetchTile(url, controller.signal);
                if (res === 'missing') {
                    job.missing++;
                } else if (res) {
                    const blob = await res.blob();
                    await cache.put(url, new Response(blob, {
                        headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg' }
                    }));
                    job.bytes += blob.size;
                } else {
                    job.failed++;
                }
            } catch (e) {
                if (controller.signal.aborted) return;
                error = e;  // QuotaExceededError, mostly: stop everything
                return;
            }
            job.done++;
            renderOfflineProgress();
            if (job.done % OFFLINE_META_EVERY === 0) {
                Object.assign(meta, { saved: job.done - job.missing - job.failed,
                    missing: job.missing, failed: job.failed, bytes: job.bytes });
                writeMeta(cache, meta).catch(() => {});
            }
        }
    };
    await Promise.all(Array.from({ length: OFFLINE_CONCURRENCY }, worker));

    const cancelled = controller.signal.aborted;
    Object.assign(meta, {
        saved: job.done - job.missing - job.failed,
        missing: job.missing, failed: job.failed, bytes: job.bytes,
        complete: !cancelled && !error && job.done === total
    });
    await writeMeta(cache, meta).catch(() => {});

    offlineJob = null;
    releaseWakeLock(job);
    window.removeEventListener('beforeunload', warnBeforeUnload);
    renderOfflineProgress();
    renderOfflineEstimate();
    renderOfflineList();

    if (error) {
        const quota = error.name === 'QuotaExceededError';
        log(`Téléchargement interrompu : ${quota ? 'espace de stockage insuffisant' : error.message}`, 'error');
    } else if (cancelled) {
        log(`Téléchargement annulé après ${formatCount(meta.saved)} tuiles`, 'info');
    } else {
        log(`Carte « ${meta.name} » enregistrée : ${formatCount(meta.saved)} tuiles, ${formatBytes(meta.bytes)}` +
            (meta.failed ? `, ${formatCount(meta.failed)} en échec` : ''), meta.failed ? 'error' : 'success');
    }
}

function cancelOfflineDownload() {
    if (offlineJob) offlineJob.controller.abort();
}

function warnBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = '';
}

// Keeps the screen on during the download: Android suspends the page when the
// screen locks. The lock is dropped when the app goes to the background, so it
// is taken again when the app comes back.
async function acquireWakeLock() {
    if (!offlineJob || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try { offlineJob.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}

function releaseWakeLock(job) {
    if (job.wakeLock) job.wakeLock.release().catch(() => {});
    job.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
});

document.addEventListener('DOMContentLoaded', () => {
    if (offlineAvailable()) document.getElementById('offlineBtn').hidden = false;
});
