// Service worker mínimo: solo cachea el "shell" estático de la app (para que abra
// sin conexión), nunca las respuestas del SIC -- esas siempre deben ser en vivo.
const CACHE_NAME = 'sic-audit-shell-v1';
const SHELL_FILES = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/style.css',
    './js/vehiculos.js',
    './data/paradas.js',
    './js/api.js',
    './js/logic.js',
    './js/storage.js',
    './js/csv.js',
    './js/app.js',
    './icons/icon.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    // Nunca interceptar llamadas a los dominios del SIC: siempre deben ir a la red.
    if (url.hostname.includes('utryt.com.co')) return;
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});
