const CACHE_NAME = 'twivideo-shorts-v9';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/src/style.css',
    '/src/feed-logic.js',
    '/src/main.js',
    '/manifest.webmanifest',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Noto+Sans+JP:wght@400;500;700;900&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
];

function appShell(url) {
    if (url.origin !== self.location.origin) return false;
    return url.pathname === '/'
        || url.pathname === '/index.html'
        || url.pathname === '/sw.js'
        || url.pathname === '/manifest.webmanifest'
        || url.pathname.startsWith('/src/');
}

async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response && response.status === 200 && request.method === 'GET') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
    }
}

// Install: prime the cache from the network. cache: 'reload' avoids storing
// a copy that an older worker already had in the HTTP cache.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => Promise.all(STATIC_ASSETS.map(async (asset) => {
            try {
                const response = await fetch(asset, { cache: 'reload' });
                if (response.ok) await cache.put(asset, response);
            } catch {
                // A missing font or a blocked CDN must not keep the old worker in place.
            }
        })))
    );
    self.skipWaiting();
});

// Activate: drop old caches and take control. Do not navigate open pages
// here. client.navigate() during activate deadlocks the renderer when a
// long /proxy/media response is already in flight: the worker waits for the
// navigation, and the navigation waits for this activate handler.
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

// Third-party static assets that are worth keeping offline.
const CACHEABLE_HOSTS = new Set([
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
]);

function cacheFirstAllowed(url) {
    if (url.origin === self.location.origin) return url.pathname.startsWith('/icons/');
    return CACHEABLE_HOSTS.has(url.hostname);
}

// Fetch: the app shell is network-first so a new main.js is not pinned by
// the previous cache. API and media relays are network-only. Fonts, icons
// and the CDN scripts are cache-first. Anything else is left to the browser.
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (request.headers.get('service-worker')) {
        event.respondWith(fetch(request));
        return;
    }

    // Leave API and media relays to the browser. Piping a <video> Range
    // request through the worker makes Chrome re-download the rest of a
    // progressive file on every reconnect, which locks the renderer.
    if (url.origin === self.location.origin
        && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy/'))) {
        return;
    }

    // Direct CDN video (85po plays straight from its CDN) and ranking
    // thumbnails: a 206 cannot be stored, and caching every poster of every
    // ranking would grow the cache without limit.
    if (request.headers.has('range') || request.destination === 'video' || request.destination === 'audio') {
        return;
    }

    if (appShell(url)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (!cacheFirstAllowed(url)) return;

    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                if (response.ok && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME)
                        .then((cache) => cache.put(request, clone))
                        .catch(() => {});
                }
                return response;
            });
        })
    );
});
