// Service worker interkomu – tylko powiadomienia push (bez zapisywania strony w pamięci podręcznej).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Interkom', body: e.data?.text() || '' }; }
  // wzory wibracji (Android; iPhone wibruje według ustawień powiadomień w systemie)
  const VIB = { call: [600, 200, 600, 200, 600, 200, 600], urgent: [400, 150, 400, 150, 400], timer: [250, 120, 250, 120, 700], msg: [150, 80, 150], soft: [120] };
  e.waitUntil(self.registration.showNotification(d.title || 'Interkom', {
    body: d.body || '', tag: d.tag || undefined, renotify: true, requireInteraction: !!d.urgent,
    icon: '/icon-192.png', badge: '/icon-192.png', vibrate: VIB[d.vib] || (d.urgent ? VIB.urgent : VIB.soft), data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); return; } }
    await self.clients.openWindow(e.notification.data?.url || '/');
  })());
});
