/* eslint-disable no-restricted-globals */

const CACHE_VERSION = "v3";
const STATIC_CACHE_NAME = `instafy-static-${CACHE_VERSION}`;
const CACHE_PREFIX = "instafy-static-";
const APP_SHELL_URL = "/index.html";
const SW_PUSH_DEBUG_EVENT = "instafy:sw-push-debug";

const PRECACHE_URLS = [
  APP_SHELL_URL,
  "/manifest.webmanifest?v=3",
  "/favicon.ico?v=3",
  "/icon.svg?v=3",
  "/apple-touch-icon.png?v=3",
  "/icon-192.png?v=3",
  "/icon-512.png?v=3",
  "/icon-maskable-192.png?v=3",
  "/icon-maskable-512.png?v=3",
  "/icon.png?v=3",
];

async function broadcastPushDebug(payload) {
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(
      windows.map((client) => {
        try {
          return client.postMessage({ type: SW_PUSH_DEBUG_EVENT, ...payload });
        } catch {
          return undefined;
        }
      }),
    );
  } catch {
    // ignore debug broadcast failures
  }
}

function isCacheableAsset(pathname) {
  if (pathname === "/sw.js") {
    return false;
  }
  if (pathname.startsWith("/assets/")) {
    return true;
  }
  return (
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".woff2") ||
    pathname.endsWith(".webmanifest")
  );
}

async function precacheBuildAssets(cache) {
  try {
    const response = await fetch(APP_SHELL_URL, { cache: "reload" });
    if (!response.ok) {
      return;
    }

    const html = await response.text();
    await cache.put(
      APP_SHELL_URL,
      new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    );

    const assetUrls = new Set();
    for (const match of html.matchAll(/(?:href|src)=["'](\/assets\/[^"']+)["']/g)) {
      assetUrls.add(match[1]);
    }

    await Promise.all(
      Array.from(assetUrls).map(async (assetUrl) => {
        try {
          await cache.add(assetUrl);
        } catch {
          // ignore individual precache failures
        }
      }),
    );
  } catch {
    // ignore precache failures
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE_NAME);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            // ignore individual precache failures
          }
        }),
      );
      await precacheBuildAssets(cache);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE_NAME) {
            return caches.delete(key);
          }
          return undefined;
        }),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(STATIC_CACHE_NAME);
          if (response.ok) {
            await cache.put(APP_SHELL_URL, response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(STATIC_CACHE_NAME);
          const cached = await cache.match(APP_SHELL_URL);
          return cached ?? new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        }
      })(),
    );
    return;
  }

  if (!isCacheableAsset(url.pathname)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) {
        event.waitUntil(
          (async () => {
            try {
              const response = await fetch(request);
              if (response.ok) {
                await cache.put(request, response.clone());
              }
            } catch {
              // ignore background refresh failures
            }
          })(),
        );
        return cached;
      }

      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      await broadcastPushDebug({
        phase: "received",
        hasData: Boolean(event.data),
      });

      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch (_error) {
        payload = {};
      }

      const title = typeof payload.title === "string" && payload.title.trim().length > 0 ? payload.title : "Instafy";
      const body =
        typeof payload.body === "string" && payload.body.trim().length > 0 ? payload.body : "New assistant message";
      const url = typeof payload.url === "string" && payload.url.trim().length > 0 ? payload.url : "/studio";

      await self.registration.showNotification(title, {
        body,
        data: { url },
      });

      await broadcastPushDebug({
        phase: "shown",
        title,
        hasBody: body.length > 0,
        hasUrl: Boolean(url),
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification?.close?.();
  const url = event.notification?.data?.url || "/studio";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(url);
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
