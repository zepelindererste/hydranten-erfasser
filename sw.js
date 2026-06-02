/* Service Worker – cacht die App-Hülle für Offline-Start.
   Kartenkacheln und OSM-API werden NICHT gecacht (immer live). */
const CACHE = "hydranten-erfasser-v5";
const SHELL = [
  "./", "./index.html", "./app.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = e.request.url;
  // API & Kacheln: nie cachen
  if (url.includes("/api/0.6/") || url.includes("/oauth2/") || url.includes("tile.openstreetmap.org")) return;
  // App-Hülle: cache-first, sonst Netz
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp=>{
    if(e.request.method==="GET" && resp.ok && (url.startsWith(self.location.origin) || url.includes("unpkg.com"))){
      const cp=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp));
    }
    return resp;
  }).catch(()=>r)));
});
