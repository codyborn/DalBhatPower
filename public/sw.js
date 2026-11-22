// Dal Bhat Power service worker: makes the app installable and usable with no signal.
//  - App files: network first (so deploys show up), cached copy when offline
//  - Libraries from CDNs: cache first (versioned URLs never change)
//  - Map tiles and photos: served from cache when available, refreshed in the background
//  - Firestore / Auth / APIs: untouched (Firestore has its own offline cache)
// Replaced with the git commit by the deploy workflow, so every deploy installs a fresh worker.
const VERSION = '__APP_VERSION__';
const SHELL = `shell-${VERSION}`;
const LIBS = 'libs-v1'; // versioned CDN URLs never change, so keep this across deploys
const TILES = 'tiles';
const PHOTOS = 'photos';
const MAX_TILES = 2500;
const MAX_PHOTOS = 150; // photos load as opaque responses, which browsers count heavily against storage quota

const SHELL_FILES = [
  '/', '/index.html', '/styles.css', '/app.js', '/config.js', '/towns.js', '/photo.js', '/charts.js',
  '/profile.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];
const LIB_HOSTS = ['www.gstatic.com', 'unpkg.com', 'cdn.jsdelivr.net'];
const TILE_HOSTS = ['basemaps.cartocdn.com', 'tile.openstreetmap.org'];
const PHOTO_HOST = 'firebasestorage.googleapis.com';

// The page asks a waiting worker to take over right away.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, LIBS, TILES, PHOTOS]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    if (request.mode === 'navigate') return cache.match('/index.html');
    throw new Error('offline');
  }
}

async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') {
    cache.put(request, res.clone()).then(() => max && trim(cacheName, max));
  }
  return res;
}

async function staleWhileRevalidate(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone()).then(() => trim(cacheName, max));
    return res;
  }).catch(() => hit);
  return hit || refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/__/')) return; // Firebase Auth helper pages
    event.respondWith(networkFirst(request));
  } else if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, LIBS));
  } else if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(staleWhileRevalidate(request, TILES, MAX_TILES));
  } else if (url.hostname === PHOTO_HOST && url.searchParams.get('alt') === 'media') {
    event.respondWith(cacheFirst(request, PHOTOS, MAX_PHOTOS));
  }
  // everything else (Firestore, Auth, Nominatim, Open-Meteo…) goes straight to the network
});
