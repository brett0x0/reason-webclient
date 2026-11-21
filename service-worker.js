// Shell service worker. Must NOT mediate workers/scripts under COEP:
// Safari blocks Worker() loads when a SW calls respondWith() for them,
// even when Cross-Origin-Resource-Policy is present on the network response.
const CACHE_NAME = "osrs-typescript-shell-v3";
const SHELL_URL = new URL("index.html", self.registration.scope).href;

/**
 * GitHub Pages (and any plain static host) cannot send COOP/COEP, and the
 * client needs `crossOriginIsolated` to share its sparse cache with the render
 * workers through SharedArrayBuffer. Serving the document from here lets the
 * browser see those headers anyway; the page reloads once so the first
 * (uncontrolled) load turns into an isolated one.
 */
function withIsolationHeaders(response) {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then((cache) => cache.addAll([SHELL_URL]))
            .catch(() => {}),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((k) => k.startsWith("osrs-typescript-shell-") && k !== CACHE_NAME).map((k) => caches.delete(k))),
            )
            .then(() => self.clients.claim()),
    );
});

// Plugin notifications (RuneLite's Notifier) shown through the worker: a click brings the game back.
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((windows) => {
                const scope = self.registration.scope;
                const open = windows.find((client) => client.url.startsWith(scope) && "focus" in client);
                if (open) return open.focus();
                return self.clients.openWindow ? self.clients.openWindow(self.registration.scope) : undefined;
            })
            .catch(() => {}),
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    const destination = event.request.destination;
    if (
        destination === "worker" ||
        destination === "script" ||
        destination === "sharedworker" ||
        destination === "audioworklet" ||
        destination === "paintworklet"
    ) {
        // Let the browser fetch directly so COEP/CORP checks see real response headers.
        return;
    }

    let url;
    try {
        url = new URL(event.request.url);
    } catch {
        return;
    }

    if (url.origin === self.location.origin && url.pathname.startsWith("/static/")) {
        return;
    }

    if (event.request.mode === "navigate") {
        // Network-first navigations so the isolation headers are fresh, and so a
        // stale shell never hides a redeploy.
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const isolated = withIsolationHeaders(response);
                    const copy = isolated.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, copy)).catch(() => {});
                    return isolated;
                })
                .catch(() =>
                    caches
                        .match(SHELL_URL)
                        .then((cached) => (cached ? withIsolationHeaders(cached) : Response.error())),
                ),
        );
    }
});
