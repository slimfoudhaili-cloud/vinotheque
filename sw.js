// ─── SERVICE WORKER — Cave à Vin PWA ─────────────────────────────────────────
const CACHE_NAME = "cave-v1";

// Fichiers à mettre en cache pour le mode offline
const STATIC_ASSETS = [
  "/",
  "/index.html",
];

// Installation : mise en cache des assets statiques
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activation : suppression des anciens caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch : Network first, cache fallback
self.addEventListener("fetch", (event) => {
  // On ne cache pas les requêtes Supabase ni l'API Anthropic
  if (
    event.request.url.includes("supabase.co") ||
    event.request.url.includes("anthropic.com")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Met en cache la réponse fraîche
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => {
        // Fallback sur le cache si offline
        return caches.match(event.request).then((cached) => {
          return cached || caches.match("/index.html");
        });
      })
  );
});
