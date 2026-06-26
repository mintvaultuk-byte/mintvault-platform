/*
 * MintVault portal — minimal service worker.
 *
 * Its ONLY job is to make the staff/admin portal installable as a PWA (a
 * registered service worker with a fetch handler is part of the install
 * criteria). It deliberately does NO caching: the grading/print portal must
 * never serve stale code, so every request goes straight to the network. If
 * staleness ever became a feature we'd add it explicitly and version it.
 */
self.addEventListener("install", () => {
  // Activate immediately — no waiting phase, no cached old worker lingering.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Network pass-through. The handler must exist for installability, but it does
// not call respondWith — so the browser performs its normal network fetch and
// nothing is cached or rewritten.
self.addEventListener("fetch", () => {
  /* intentionally empty: default network behaviour, no offline cache */
});
