// Croton Community Forum service worker: shows each push as a notification and
// opens its topic when tapped. Nothing else — no caching, no offline pages.
// Adapted from HookPush's (hookpush.live/sw.js). Every push must show a
// notification: iPhones and Safari cancel the subscription of a site whose
// pushes show nothing.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data.json(); } catch { msg = { body: e.data ? e.data.text() : '' }; }
  const options = {
    body: msg.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: msg.url || null },
  };
  if (msg.tag) { options.tag = msg.tag; options.renotify = msg.renotify !== false; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Croton Community Forum', options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url;
  const href = url ? new URL(url, self.location.href).href : self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    // That page already open: bring it forward. Any forum page open: take it there.
    const same = list.find((c) => c.url === href && 'focus' in c);
    if (same) return same.focus();
    const any = list.find((c) => 'navigate' in c && 'focus' in c);
    if (any) return any.navigate(href).then((c) => (c || any).focus());
    return self.clients.openWindow(href);
  }));
});
