/* Assistente IA service worker by Diogo Moreira. MIT License.
 * Keeps the app shell available offline and turns empty push messages into notifications. */
const CACHE = 'assistente-shell-v4';
const SHELL = ['/', '/css/app.css', '/js/main.js', '/js/core.js', '/js/charts.js', '/js/notifications.js', '/js/approvals.js',
  '/js/push.js', '/js/views/overview.js', '/js/views/activity.js', '/js/views/insights.js', '/js/views/rules.js',
  '/js/views/github.js', '/js/views/devices.js', '/js/views/downloads.js', '/js/views/settings.js', '/js/views/about.js',
  '/assets/logo.svg', '/assets/claude.svg', '/assets/codex.svg', '/assets/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Network first so updates show immediately; the cached shell only answers when offline. The API is never cached.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || (event.request.mode === 'navigate' ? caches.match('/') : Response.error()))));
});

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let items = [];
    try {
      const response = await fetch('/api/notices', {credentials: 'include', cache: 'no-store'});
      if (response.ok) items = (await response.json()).items || [];
    } catch { /* Offline or signed out: fall back to a generic notice. */ }
    if (!items.length) items = [{id: 'generic', title: 'Assistente IA', body: 'Something needs your attention.', url: '/#/overview', kind: 'generic'}];
    await Promise.all(items.slice(0, 3).map(item => self.registration.showNotification(item.title, {
      body: item.body, tag: 'notice-' + item.id, icon: '/assets/icon-192.png', badge: '/assets/icon-badge.png',
      data: {url: item.url || '/#/overview'}, renotify: false, requireInteraction: item.kind === 'approval'
    })));
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#/overview', location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const open = windows.find(client => new URL(client.url).origin === location.origin);
    if (open) { await open.focus(); return open.navigate(target).catch(() => null); }
    return self.clients.openWindow(target);
  })());
});
