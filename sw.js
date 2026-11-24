// Service worker: makes the app installable and usable offline.
//
// - App shell (HTML, CSS, JS, icons): network first, revalidated past the
//   HTTP cache, cache as fallback, so a new version is picked up as soon as
//   the device is online.
// - Libraries and fonts from CDNs: cache first (URLs are versioned).
// - Map tiles: cache first, keeping the most recent TILE_LIMIT tiles, so areas
//   already viewed stay available without network. Only CORS responses are
//   stored: opaque ones would count several MB each against the quota.
// - IGN SCAN 25 tiles (private WMTS): looked up in every cache, which includes
//   the areas saved for offline use (caches named ign-pack-*, see offline.js),
//   then the network. They are not cached on the fly.
// - Elevation API and anything else: straight to the network.

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;
const TILE_CACHE = 'tiles-v1';
const TILE_LIMIT = 3000;
const TRIM_EVERY = 50;
const OFFLINE_PREFIX = 'ign-pack-';

const SHELL = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './offline.js',
    './geoloc.js',
    './polygon.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/favicon-32.png'
];

const CDN = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

const STATIC_HOSTS = [
    'unpkg.com',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'raw.githubusercontent.com'
];

function isTile(url) {
    if (url.hostname.endsWith('tile.openstreetmap.org')) return true;
    if (url.hostname === 'server.arcgisonline.com') return true;
    // Public Géoplateforme WMTS only; the private endpoint is left to the network.
    return url.hostname === 'data.geopf.fr' && url.pathname === '/wmts';
}

function isOfflineTile(url) {
    return url.hostname === 'data.geopf.fr' && url.pathname === '/private/wmts';
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const shell = await caches.open(SHELL_CACHE);
        await shell.addAll(SHELL);
        // CDN files are best effort: a failure must not block installation.
        const statics = await caches.open(STATIC_CACHE);
        await Promise.all(CDN.map(url => statics.add(url).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = [SHELL_CACHE, STATIC_CACHE, TILE_CACHE];
        const names = await caches.keys();
        // Offline areas belong to the user: never drop them on update.
        const stale = names.filter(n => !keep.includes(n) && !n.startsWith(OFFLINE_PREFIX));
        await Promise.all(stale.map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
    } else if (isTile(url)) {
        event.respondWith(cacheFirst(request, TILE_CACHE, true));
    } else if (isOfflineTile(url)) {
        event.respondWith(offlineFirst(request));
    } else if (STATIC_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, STATIC_CACHE, false));
    }
    // Everything else (elevation API...) goes to the network.
});

async function networkFirst(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        // no-cache: GitHub Pages lets the HTTP cache keep files 10 minutes,
        // which would hold back a new version; revalidating costs a 304.
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch (err) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const shell = await cache.match('./index.html');
            if (shell) return shell;
        }
        throw err;
    }
}

async function offlineFirst(request) {
    const cached = await caches.match(request, { ignoreVary: true });
    return cached || fetch(request);
}

let tilePuts = 0;

async function cacheFirst(request, cacheName, isTileRequest) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
        await cache.put(request, response.clone());
        if (isTileRequest && ++tilePuts % TRIM_EVERY === 0) trimCache(cache, TILE_LIMIT);
    }
    return response;
}

// Cache keys come back in insertion order: drop the oldest entries.
async function trimCache(cache, limit) {
    const keys = await cache.keys();
    const excess = keys.length - limit;
    for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}
