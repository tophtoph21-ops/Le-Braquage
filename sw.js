/* LE BRAQUAGE — service de cache
   Permet à l'application de s'installer et de s'ouvrir sans connexion.
   Le solo et l'apprentissage fonctionnent alors entièrement hors ligne. */
"use strict";
const CACHE = "braquage-v1";
const FICHIERS = [
  "/",
  "/manifest.webmanifest",
  "/icone-192.png",
  "/icone-512.png"
];

/* à l'installation : on met le jeu de côté */
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FICHIERS))
      .then(() => self.skipWaiting())
  );
});

/* à l'activation : on efface les anciennes versions */
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

/* on sert le réseau en priorité (pour recevoir les mises à jour),
   et le cache dès que la connexion manque */
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(rep => {
        if (rep && rep.status === 200) {
          const copie = rep.clone();
          caches.open(CACHE).then(c => c.put(req, copie));
        }
        return rep;
      })
      .catch(() =>
        caches.match(req).then(rep => rep || caches.match("/"))
      )
  );
});
