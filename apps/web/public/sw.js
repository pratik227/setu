/*
 * The offline shell.
 *
 * Setu's data layer is already offline-first: the store is IndexedDB, a warm boot
 * renders from it without a single relay round-trip, and every screen reads local
 * rows before the network answers. What was missing is the layer *under* that — the
 * HTML, the bundle, the fonts. Without a service worker an offline launch dies
 * before the store is even opened, which makes "local-first" a property of every
 * layer except the first one to run.
 *
 * The strategy is chosen around one hard constraint: `index.html` must never go
 * stale. It names the content-hashed bundles, so a cached copy pins its holder to a
 * dead deploy (`netlify.toml` says the same thing to the CDN). Hence:
 *
 *  - **Navigations are network-first.** Online users always get the newest deploy;
 *    the successful response refreshes the cached shell; only a network failure
 *    serves the cache. Staleness is bounded to "what you last saw", exactly like
 *    the event store.
 *  - **`/assets/*` is cache-first.** Every file there carries a content hash and is
 *    served `immutable` — re-validating it is pure waste, and offline it is the
 *    difference between the app booting and a white page.
 *  - **Cross-origin is not touched.** Relay traffic is WebSocket (not fetchable),
 *    and media from strangers' hosts must not accumulate in a cache that none of
 *    the store's retention policy governs. The browser's HTTP cache handles it.
 *
 * No push, no background sync, no analytics — a service worker is a privileged
 * network shim, and this one does nothing but make the shell load.
 */

const SHELL_CACHE = "setu-shell-v1";
const ASSET_CACHE = "setu-assets-v1";

/**
 * Cached at install so the *first* offline launch works, not just the second.
 * Everything else arrives via the fetch handlers.
 */
const SHELL_URLS = ["/", "/theme-init.js", "/favicon.svg", "/site.webmanifest"];

/**
 * Hashed assets accumulate across deploys — the hash changes, the old file stays
 * cached forever, and nothing here can know which files the current deploy still
 * references. A count cap bounds the disk cost; eviction is oldest-inserted,
 * which after a deploy is exactly the previous deploy's files.
 */
const MAX_ASSET_ENTRIES = 160;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic and rejects on any 404, which would brick the install.
      // Cache each independently instead: a missing manifest must not cost the
      // offline shell its index.html.
      await Promise.allSettled(
        SHELL_URLS.map(async (url) => {
          const response = await fetch(url, { cache: "no-cache" });
          if (response.ok) await cache.put(url, response);
        }),
      );
      // Take over immediately: this worker only ever changes how requests are
      // *routed*, never what they mean, so there is nothing to wait for.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older worker versions — the names carry the version.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Delete oldest-inserted entries beyond the cap. */
async function trimAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  const excess = keys.length - MAX_ASSET_ENTRIES;
  for (let i = 0; i < excess; i += 1) {
    const key = keys[i];
    if (key) await cache.delete(key);
  }
}

/** Network-first navigation: newest deploy online, last-seen shell offline. */
async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Keyed as "/" whatever the path: this is a single-page app, so every
      // route serves the same document, and offline any deep link must find it.
      await cache.put("/", response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match("/");
    if (cached) return cached;
    // Nothing cached and no network: let the browser show its own error rather
    // than a synthetic page pretending to be the app.
    throw new Error("offline with no cached shell");
  }
}

/** Cache-first for content-hashed, immutable assets. */
async function handleAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    // Fire-and-forget: trimming must never delay serving the response.
    trimAssets().catch(() => {});
  }
  return response;
}

/**
 * Stale-while-revalidate for the handful of small same-origin files that are
 * neither hashed nor the document (theme-init.js, the favicon, the manifest):
 * served instantly from cache, refreshed in the background for next time.
 */
async function handleShellFile(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const fresh = await refresh;
  if (fresh) return fresh;
  throw new Error("offline with no cached copy");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Same-origin only — see the module comment on cross-origin media.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(handleAsset(request));
    return;
  }
  event.respondWith(handleShellFile(request));
});
