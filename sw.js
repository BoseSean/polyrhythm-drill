/* Polyrhythm Drill — service worker (offline app shell).
   Relative paths so it works under a GitHub Pages subpath or a domain root.

   HARD RULE: only *navigation* requests may fall back to index.html. A CSS/JS/
   image request must NEVER receive the HTML shell — otherwise a cache miss +
   failed network fetch makes the page load as unstyled, inert HTML (the classic
   "only the HTML loaded" bug, especially in proxied cloud-preview sandboxes). */
const CACHE = 'polyrhythm-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'apple-touch-icon.png',
  'favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // best-effort: one missing/blocked asset must not abort the whole install
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // Leave cross-origin requests (CDNs, etc.) completely untouched.
  if (url.origin !== self.location.origin) return;

  // Navigations → network-first (always fresh in dev/preview), cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() =>
        caches.match('index.html', { ignoreSearch: true }).then((r) => r || caches.match('./'))
      )
    );
    return;
  }

  // Static assets → cache-first, revalidate in background.
  // On a miss + network failure we let the request FAIL normally — never return HTML.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
      return cached || network;   // network rejection propagates as a real failed request
    })
  );
});
