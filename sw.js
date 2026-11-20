const SCOPE = self.registration.scope;
const CACHE_PREFIX = `zahid-tech-shell-${SCOPE}-`;
const CACHE = `${CACHE_PREFIX}v3`;
const SHELL = [
  "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./vendor/leaflet/leaflet.css", "./vendor/leaflet/leaflet.js"
].map(path => new URL(path, SCOPE).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(async names => {
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  }));
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && [SCOPE, SHELL[0]].includes(url.origin + url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(SHELL[0]);
      return cached || fetch(request);
    }));
  } else if (SHELL.includes(request.url)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(request);
      return cached || fetch(request);
    }));
  }
});
