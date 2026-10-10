// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// One Connect service worker. Deliberately tiny: it precaches ONLY a static offline page, the
// manifest and the icons. It never handles a request that is not one of those, never adds anything
// at runtime, and never touches the network for anything else. So no API or event response, transcript,
// prompt, source, evidence, credential, cookie, pairing link or sign-in link is ever stored here,
// and mutations are never intercepted, replayed or queued.
const VERSION = 'one-connect-shell-v1';
const SHELL = ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const NEVER = /^\/(api|ws|auth|pair)(\/|$)/;
const SENSITIVE_QUERY = /(^|[?&])(code|token|ticket|t|key|session|csrf)=/i;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('one-connect-shell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: not ours
  if (req.method !== 'GET') return; // mutations go straight to the network and are never queued
  if (NEVER.test(url.pathname) || SENSITIVE_QUERY.test(url.search)) return; // API, events, sockets, sign-in, pairing
  if (req.mode === 'navigate') {
    // Navigations are never stored. If the network is down, show the static offline page.
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html').then((r) => r || Response.error())));
    return;
  }
  if (SHELL.includes(url.pathname)) event.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/phone');
  }));
});
