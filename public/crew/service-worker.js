// Minimal service worker: exists to make the crew MDT installable (a
// fetch handler is part of the PWA installability criteria) and to cache
// the static app shell for resilience against a flaky connection between
// missions. Deliberately NOT full offline-first (API calls always require
// a live network round-trip) -- that's explicitly out of this project's
// scope; see the plan's "Notification Reliability" and scope sections.
const SHELL_CACHE = 'cadcs-crew-shell-v2';
const SHELL_FILES = ['/crew/', '/crew/app.js', '/crew/style.css', '/shared/style.css', '/shared/api.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only intercept the app shell; API/socket traffic always goes straight
  // to the network -- a stale API response is worse than a failed one.
  if (event.request.method !== 'GET' || !SHELL_FILES.includes(url.pathname)) return;

  // Network-first, cache as fallback -- NOT cache-first. A cache-first
  // shell means every future code deploy keeps silently serving whatever
  // JS happened to be cached on first install, forever, with no update
  // path (this was a real bug: found via manual testing when an edited
  // app.js kept running stale behavior after a server restart). Resilience
  // against a flaky connection is still fully preserved -- the cache is
  // only used when the network request actually fails.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
