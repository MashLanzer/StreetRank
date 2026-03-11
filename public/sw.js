/**
 * sw.js - Basic Service Worker for StreetRank PWA
 */
const CACHE_NAME = 'streetrank-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/profile.html',
  '/profile-setup.html',
  '/style.css',
  '/mobile.css',
  '/app.js',
  '/firebase.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
});

self.addEventListener('fetch', (e) => {
  // Simple network-first falling back to cache
  e.respondWith(
    fetch(e.request).catch(() => {
      return caches.match(e.request);
    })
  );
});
