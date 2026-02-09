const CACHE_NAME = 'oaks-mart-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

// install
self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// activate
self.addEventListener('activate', ev => {
  ev.waitUntil(clients.claim());
});

// fetch
self.addEventListener('fetch', ev => {
  const req = ev.request;
  // network-first for API-like endpoints (none yet), otherwise cache-first
  ev.respondWith(
    caches.match(req).then(cached => cached || fetch(req).catch(() => cached))
  );
});
