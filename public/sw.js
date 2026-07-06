// Cache-first with background refresh: on any GET, serve the cached copy
// immediately if there is one (so the app works with zero signal, e.g. a
// basement gym), while also fetching the network in the background to keep
// the cache fresh for next time. Bump CACHE_VERSION when the app shell
// changes so old caches get cleaned up on the next activate.
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'rowing-pacer-' + CACHE_VERSION;

const PRECACHE_URLS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon.svg',
  'icons/icon-512.png',
  'workout.example.json',
  'workouts/index.json',
  'workouts/5min-warmup.json',
  'workouts/10min-starter-endurance.json',
  'workouts/10min-starter-interval.json',
  'workouts/10min-intermediate-30-30.json',
  'workouts/10min-expert-power.json',
  'workouts/15min-starter-endurance.json',
  'workouts/15min-intermediate-pyramid.json',
  'workouts/15min-intermediate-strength.json',
  'workouts/15min-expert-strength.json',
  'workouts/20min-starter-endurance.json',
  'workouts/20min-intermediate-endurance.json',
  'workouts/20min-intermediate-40-20.json',
  'workouts/20min-expert-8x1.json',
  'workouts/20min-expert-strength.json',
  'workouts/30min-starter-endurance.json',
  'workouts/30min-intermediate-endurance.json',
  'workouts/30min-intermediate-4x4.json',
  'workouts/30min-expert-pyramid.json',
  'workouts/30min-expert-endurance.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
