// Offline support for /clock. The page is network-first so deploys show up right away;
// the manifest, icons and the Pretendard files from jsDelivr are cache-first.
const CACHE = 'clock-v1';
const PRECACHE = [
  '/clock',
  '/clock.webmanifest',
  '/image/clock-icon-180.png',
  '/image/clock-icon-192.png',
  '/image/clock-icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('clock-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

function remember(key, response) {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(key, copy));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => remember('/clock', response)).catch(() => caches.match('/clock')));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => remember(request, response))));
});
