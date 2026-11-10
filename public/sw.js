importScripts("/precache.generated.js");
const { version, files } = self.PHARMACY_ASSETS;
const CACHE = "pharmacy-shell-" + version;
const ASSETS = new Set([...files, "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/farmaworld-logo.jpeg"]);
const root = () => new Request(new URL("/", self.location.origin), { cache: "reload" });

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([root(), ...ASSETS]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Keep the previous release so open tabs can finish loading their lazy modules.
    const previous = (await caches.keys()).filter((name) => name.startsWith("pharmacy-shell-") && name !== CACHE);
    await Promise.all(previous.slice(0, -1).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function navigate(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  let response;
  try {
    response = await fetch(request, { cache: "no-cache", signal: controller.signal });
    if (response.ok) return response;
  } catch {
    // The installed shell is still available during an outage.
  } finally {
    clearTimeout(timeout);
  }
  const cache = await caches.open(CACHE);
  return (await cache.match(root())) ?? response ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(navigate(event.request));
    return;
  }
  if (ASSETS.has(url.pathname) || url.pathname.startsWith("/_next/static/")) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
