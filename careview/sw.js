const CACHE_PREFIX = "careview-";
const CACHE_NAME = `${CACHE_PREFIX}v10`;
const APP_SHELL = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];
const APP_SHELL_URLS = APP_SHELL.map((asset) => new URL(asset, self.registration.scope))
  .filter((url) => url.origin === self.location.origin)
  .map((url) => url.href);
const APP_SHELL_URL_SET = new Set(APP_SHELL_URLS);
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  // Authenticated records and stored evidence must always go to the server;
  // neither API JSON nor protected media belongs in the offline app-shell cache.
  if (requestUrl.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(INDEX_URL)));
    return;
  }

  if (!APP_SHELL_URL_SET.has(requestUrl.href)) return;

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
