// Minimal service worker: makes the Hub installable. It never caches pages or data,
// so everyone always sees current information. If the phone is offline it shows a short notice.
const OFFLINE = '/offline.html';
self.addEventListener('install', e => { e.waitUntil(caches.open('mm-hub-offline-v1').then(c => c.add(OFFLINE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;   // only page loads; data requests go straight to the network
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});