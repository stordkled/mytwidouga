const CACHE_NAME = 'twivideo-shorts-v7';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/src/style.css',
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
        if (response && response.ok && request.method === 'GET') {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
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

// Activate: drop old caches, take control, and reload open pages so they
// don't keep running a main.js the previous worker cached.
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
        const windows = await self.clients.matchAll({ type: 'window' });
        await Promise.all(windows.map((client) => client.navigate(client.url)));
    })());
});

// Fetch: the app shell is network-first so a new main.js is not pinned by
// the previous cache. API and media relays are network-only. Everything else
// (fonts, icons) stays cache-first.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.headers.get('service-worker')) {
        event.respondWith(fetch(event.request));
        return;
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    if (appShell(url)) {
        event.respondWith(networkFirst(event.request));
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
