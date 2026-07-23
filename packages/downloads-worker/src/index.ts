const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SHORT_CACHE_CONTROL = "public, max-age=120";

function normalizeKey(pathname: string) {
  const trimmed = pathname.replace(/^\/+/, "");
  return trimmed;
}

function basename(key: string) {
  const idx = key.lastIndexOf("/");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

function cacheControlForKey(key: string) {
  if (key === "desktop-app/latest.json") return SHORT_CACHE_CONTROL;
  if (/^desktop-app\/(internal|stable)\/latest(?:-[a-z]+)?\.(json|yml)$/.test(key)) {
    return SHORT_CACHE_CONTROL;
  }
  if (/^desktop-app\/desktop-app-v[^/]+\//.test(key)) return IMMUTABLE_CACHE_CONTROL;
  if (/^mobile\/[^/]+\.(zip|manifest\.json)$/.test(key)) return IMMUTABLE_CACHE_CONTROL;
  return SHORT_CACHE_CONTROL;
}

function contentDispositionForKey(key: string) {
  const name = basename(key);
  if (!name) return null;

  // Prefer forcing binary downloads rather than rendering installers or OTA archives in-browser.
  if (/\.(dmg|zip|exe|appimage|tar\.gz|blockmap)$/i.test(name)) {
    return `attachment; filename="${name}"`;
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    }

    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          "access-control-allow-origin": "*",
        },
      });
    }

    const url = new URL(request.url);
    const key = normalizeKey(url.pathname);
    if (!key) {
      return new Response("Not Found", { status: 404, headers: { "access-control-allow-origin": "*" } });
    }

    const object = await env.DOWNLOADS_BUCKET.get(key);
    if (!object) {
      return new Response("Not Found", { status: 404, headers: { "access-control-allow-origin": "*" } });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", cacheControlForKey(key));
    headers.set("access-control-allow-origin", "*");

    const contentDisposition = contentDispositionForKey(key);
    if (contentDisposition) {
      headers.set("content-disposition", contentDisposition);
    }

    if (method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    return new Response(object.body, { status: 200, headers });
  },
};

interface Env {
  DOWNLOADS_BUCKET: R2Bucket;
}
