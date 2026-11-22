const CACHE = 'nimbus-shell-v3';
const SHELL = [
  '/',
  '/assets/app.js',
  '/assets/styles.css',
  '/assets/artifacts.css',
  '/offline.html',
  '/icon.svg',
  '/manifest.webmanifest',
];

function offlineResponse() {
  return new Response('<!doctype html><html lang="it"><meta charset="utf-8"><title>Nimbus offline</title><body><h1>Nimbus non raggiungibile</h1><p>Controlla la connessione e riprova.</p></body></html>', {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/p/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => (await caches.match('/offline.html')) ?? offlineResponse()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      } catch {
        return cached ?? new Response(null, { status: 504, statusText: 'Offline' });
      }
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Nimbus', body: 'Nuovo messaggio', url: '/', tag: 'nimbus' };
  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch {
    // generic payload
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: payload.tag,
      data: { url: payload.url },
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
