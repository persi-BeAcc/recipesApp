// sw.js — network-first service worker
//
// Strategy:
//   • App shell (HTML, manifest, fonts): network-first, fall back to cache.
//     Lets us push updates without a hard refresh while still working offline.
//   • API GETs (recipe list & individual recipes): network-first, cache the
//     response so the kitchen wifi cutting out doesn't kill your dinner.
//   • API mutations (POST/PUT/DELETE): always network. Never cached.
//
// Bump CACHE_NAME on every release alongside the version chip in recipes.html.

const CACHE_NAME = 'recipes-v2026.05.02.37';

const APP_SHELL = [
  '/',
  '/recipes.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Don't fail install if some shell items 404 (e.g. icons not yet uploaded)
      Promise.all(APP_SHELL.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET — never cache mutations.
  if (req.method !== 'GET') return;

  // Cross-origin (Google Fonts, React/Babel CDN): cache-first, populate on miss.
  if (url.origin !== self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Same-origin: network-first with cache fallback.
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      // Cache app shell + recipe API responses so they're available offline.
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last-ditch: serve the app shell so navigations still work offline.
    if (req.mode === 'navigate') {
      const shell = await cache.match('/recipes.html') || await cache.match('/');
      if (shell) return shell;
    }
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
