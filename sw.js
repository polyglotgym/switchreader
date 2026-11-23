// SWITCHREADER service worker: keeps a copy of the app on the phone so it
// opens without internet. Change BUILD on every release (it must match
// APP_BUILD in app.js). A changed sw.js is what makes the phone fetch the update.

const BUILD = "2026-11-23b";
const CACHE = "switchreader-" + BUILD;

// Without these the app cannot run, so if any fail, this version is not installed.
const REQUIRED = ["./", "index.html", "style.css", "app.js"];

// Nice to have. If one is missing from the folder it is simply skipped.
const OPTIONAL = [
    "xlsx.full.min.js",
    "manifest.json",
    "icon.svg",
    "apple-touch-icon.png",
    "web-app-manifest-192x192.png",
    "web-app-manifest-512x512.png"
];

function fetchFresh(url) {
    // cache: "reload" skips the browser's own cache so we never save a stale copy
    return fetch(new Request(url, { cache: "reload" }));
}

self.addEventListener("install", function(event) {
    event.waitUntil((async function() {
        const cache = await caches.open(CACHE);
        await Promise.all(REQUIRED.map(async function(url) {
            const response = await fetchFresh(url);
            if (!response.ok) throw new Error("could not save " + url);
            await cache.put(url, response);
        }));
        await Promise.all(OPTIONAL.map(async function(url) {
            try {
                const response = await fetchFresh(url);
                if (response.ok) await cache.put(url, response);
            } catch (e) { /* skipped */ }
        }));
        // No skipWaiting on purpose: the new version waits until the app has
        // been fully closed, so it never swaps in while you are reading.
    })());
});

self.addEventListener("activate", function(event) {
    event.waitUntil((async function() {
        const names = await caches.keys();
        await Promise.all(names
            .filter(function(n) { return n.startsWith("switchreader-") && n !== CACHE; })
            .map(function(n) { return caches.delete(n); }));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", function(event) {
    const request = event.request;
    if (request.method !== "GET") return;
    if (new URL(request.url).origin !== self.location.origin) return;   // leave other sites alone

    event.respondWith((async function() {
        const cache = await caches.open(CACHE);
        // Opening the app itself (any address inside it) gets the saved index.html
        const key = request.mode === "navigate" ? "./" : request;
        const saved = await cache.match(key, { ignoreSearch: true });
        if (saved) return saved;
        try {
            return await fetch(request);
        } catch (e) {
            if (request.mode === "navigate") {
                const home = await cache.match("index.html", { ignoreSearch: true });
                if (home) return home;
            }
            throw e;
        }
    })());
});
