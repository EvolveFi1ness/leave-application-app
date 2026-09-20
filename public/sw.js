// LeaveMS service worker: offline shell for static assets, network-only for APIs.
const CACHE = 'lms-v1';
const SHELL = [
  '/', '/login.html', '/employee.html', '/admin.html', '/print.html',
  '/css/app.css', '/js/api.js', '/js/employee.js', '/js/admin.js', '/js/print.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return; // always live data, never cache
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (e.request.method === 'GET' && res.ok && u.origin === location.origin) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match('/login.html'))));
});
