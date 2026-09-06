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

// The page and worker share one atomic presentation ledger. It contains only
// account/event IDs and timestamps, never notification bodies or credentials.
function notificationDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("instafy-notifications", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("presentation");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function notificationAccountAndClaim(accountId, eventId, claim) {
  const db = await notificationDatabase();
  return new Promise((resolve) => {
    const tx = db.transaction("presentation", "readwrite");
    const store = tx.objectStore("presentation");
    let accepted = false;
    const account = store.get("active-account");
    account.onsuccess = () => {
      if (account.result !== accountId) return;
      // Acceptance means this account may present, not that the event was new.
      // userVisibleOnly still requires displaying valid same-account retries.
      accepted = true;
      if (!claim) return;
      const old = store.openCursor();
      old.onsuccess = () => {
        const cursor = old.result;
        if (!cursor) return;
        if (typeof cursor.value === "number" && cursor.value < Date.now() - 30 * 24 * 60 * 60 * 1000) cursor.delete();
        cursor.continue();
      };
      store.add(Date.now(), `${accountId}:${eventId}`);
    };
    tx.oncomplete = () => { db.close(); resolve(accepted); };
    // A duplicate claim aborts the write transaction but does not revoke the
    // account match read within it. Account mismatches remain false.
    tx.onabort = () => { db.close(); resolve(accepted); };
    tx.onerror = () => {};
  });
}
const NOTIFICATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonicalPushUrl(value) {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== "/studio" || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    const support = url.searchParams.get("supportReportId");
    const project = url.searchParams.get("projectId");
    const conversation = url.searchParams.get("conversationControllerId");
    if (keys.length === 0) return "/studio";
    if (keys.length === 1 && support && NOTIFICATION_UUID.test(support)) return `/studio?supportReportId=${support.toLowerCase()}`;
    if (keys.length === 1 && project && NOTIFICATION_UUID.test(project)) return `/studio?projectId=${project.toLowerCase()}`;
    if (keys.length === 2 && project && conversation && NOTIFICATION_UUID.test(project) && NOTIFICATION_UUID.test(conversation)) return `/studio?projectId=${project.toLowerCase()}&conversationControllerId=${conversation.toLowerCase()}`;
    if (keys.length === 2 && project && NOTIFICATION_UUID.test(project) && url.searchParams.get("panel") === "automations") return `/studio?projectId=${project.toLowerCase()}&panel=automations`;
  } catch { /* Invalid or untrusted URL. */ }
  return null;
}
const SAFE_NOTIFICATION_BODIES = new Set(["There is a new reply to your support report.", "Your support report has been resolved.", "There is a new reply in your conversation.", "A run could not finish.", "Your automation has finished.", "Your automation could not finish."]);
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    if (!payload || !NOTIFICATION_UUID.test(payload.eventId) || !NOTIFICATION_UUID.test(payload.accountId)) return;
    const url = canonicalPushUrl(payload.url);
    if (!url) return;
    try {
      if (!(await notificationAccountAndClaim(payload.accountId, payload.eventId, false))) return;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: "instafy:notification-received", accountId: payload.accountId, eventId: payload.eventId });
      // userVisibleOnly requires displaying every valid push, including retries
      // and focused windows (WebKit can revoke permission for silent pushes).
      // The stable tag replaces an earlier OS notification where supported.
      // matchAll awaited above; a sign-out or account switch may have happened
      // meanwhile. The atomic second account check must gate presentation too.
      if (!(await notificationAccountAndClaim(payload.accountId, payload.eventId, true))) return;
      await self.registration.showNotification("Instafy", {
        body: SAFE_NOTIFICATION_BODIES.has(payload.body) ? payload.body : "You have a new notification.",
        tag: payload.eventId,
        renotify: false,
        data: { url, eventId: payload.eventId, accountId: payload.accountId },
      });
      await broadcastPushDebug({ phase: "shown", eventId: payload.eventId });
    } catch { /* Fail closed; durable notification remains in the center. */ }
  })());
});
async function notificationClickAccountAllowed(accountId) {
  try {
    const db = await notificationDatabase();
    const account = await new Promise((resolve, reject) => {
      const request = db.transaction("presentation").objectStore("presentation").get("active-account");
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
    return !account || account === accountId;
  } catch { return false; }
}
self.addEventListener("notificationclick", (event) => {
  event.notification?.close?.();
  const payload = event.notification?.data;
  const url = canonicalPushUrl(payload?.url);
  if (!url || !NOTIFICATION_UUID.test(payload?.accountId) || !NOTIFICATION_UUID.test(payload?.eventId)) return;
  event.waitUntil((async () => {
    // The IDs-only receipt survives RequireAuth; Studio validates the account
    // again before marking the authorized event read after opening its target.
    const target = new URL(url, self.location.origin);
    target.searchParams.set("notificationEventId", payload.eventId.toLowerCase());
    target.searchParams.set("notificationAccountId", payload.accountId.toLowerCase());
    const destination = `${target.pathname}${target.search}`;
    if (!(await notificationClickAccountAllowed(payload.accountId))) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Revalidate after the asynchronous window lookup, including signed-out
    // clicks that changed to a different signed-in account during the lookup.
    if (!(await notificationClickAccountAllowed(payload.accountId))) return;
    for (const client of windows) {
      if ("focus" in client && "navigate" in client) {
        await client.navigate(destination);
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(destination);
  })());
});
