const CACHE="jayasona-v3.1.2";
self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{
  if(new URL(e.request.url).origin===location.origin && e.request.url.includes("data.json")){
    e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
  }
});
