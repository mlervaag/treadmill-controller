// Bump on every change to this file. Static assets are network-first, so a
// normal deploy no longer needs a bump to reach clients.
const CACHE_NAME = 'treadmill-v3';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/view.html',
    '/style.css',
    '/app.js',
    '/ftms.js',
    '/hrm.js',
    '/manifest.json'
];

// Install: cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Network-first with cache fallback. The server is always on the local network,
// so the network is fast; the cache only matters when the Pi is unreachable.
// (Cache-first used to serve stale app.js/index.html after every deploy.)
function networkFirst(request) {
    return fetch(request)
        .then((response) => {
            if (response.ok) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
            }
            return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error()));
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Only handle same-origin requests (Chart.js CDN etc. go straight to network)
    if (url.origin !== self.location.origin) return;

    // TTS audio and OAuth redirects should never be cached
    if (url.pathname.startsWith('/audio/') || url.pathname.startsWith('/auth/')) return;

    event.respondWith(networkFirst(event.request));
});
