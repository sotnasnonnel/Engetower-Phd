/* Um SW simples: assume controle rápido e faz cache dinâmico. */
const CACHE = "montagem3d-v1";

// controla logo após instalar
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // limpa caches antigos se você trocar o nome do CACHE
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  })());
  self.clients.claim();
});

// estratégia "network-first" com fallback para cache
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith((async () => {
    try {
      const net = await fetch(req);
      // salva no cache para uso offline futuro
      const cache = await caches.open(CACHE);
      cache.put(req, net.clone());
      return net;
    } catch {
      // offline: tenta a partir do cache
      const cached = await caches.match(req);
      if (cached) return cached;

      // fallback para navegações SPA -> index.html
      if (req.mode === "navigate") {
        return caches.match("/index.html");
      }
      throw new Error("offline sem cache");
    }
  })());
});
