/* sw.js — ОЗВУЧКА.
   Оболочка приложения: «сначала сеть, при отсутствии — кэш» — после деплоя всегда свежие файлы,
   без интернета приложение всё равно открывается (проекты и звук лежат в IndexedDB).
   /api/* и чужие домены (кроме шрифтов) не трогаем. */
const CACHE = 'ozv-v1';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/reader.css', '/reader.js', '/install.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
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
  const url = new URL(req.url);

  // шрифты и mammoth: из кэша сразу, в фоне обновить
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/console.js') return;

  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error())))
  );
});
