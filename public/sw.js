// Service worker mínimo: hace que Scriptorium se pueda instalar como app.
// No guarda datos del equipo; solo la página, para abrir aunque la red falle un momento.
var CACHE = 'scriptorium-v1';
self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(['/', '/manifest.json', '/icons/icon-192.png']); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  var p = new URL(req.url).pathname;
  if (p.indexOf('/api/') === 0 || p.indexOf('/mcp') === 0 || p.indexOf('/oauth/') === 0) return;
  if (req.mode === 'navigate') {
    // Siempre la versión nueva; si no hay red, la última guardada.
    e.respondWith(fetch(req).then(function (r) {
      var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put('/', copy); }); return r;
    }).catch(function () { return caches.match('/'); }));
  }
});
