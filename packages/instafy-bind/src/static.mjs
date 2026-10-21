// Static file serving: GET/HEAD, Range, MIME types, index.html, no dotfiles, no symlink escapes.
import fs from "node:fs";
import path from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".pdf": "application/pdf",
  ".wasm": "application/wasm", ".pmtiles": "application/octet-stream", ".pbf": "application/x-protobuf",
  ".webmanifest": "application/manifest+json",
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/** Parse a single "bytes=a-b" range. Returns {start, end}, "unsatisfiable", or null (serve whole file). */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, a, b] = match;
  if (a === "" && b === "") return null;
  let start;
  let end;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function send(res, status, text, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers });
  res.end(text);
}

/**
 * Resolve a URL path inside root. Returns {file, stat} | {redirect} | {status}.
 * Dot segments (".bind", ".git", ".env") are never served.
 */
export function resolveStatic(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return { status: 400 };
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".") )) return { status: 404 };
  let file = path.join(root, ...segments);
  let stat;
  try {
    const real = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { status: 404 };
    stat = fs.statSync(real);
    file = real;
  } catch {
    return { status: 404 };
  }
  if (stat.isDirectory()) {
    if (!urlPath.endsWith("/")) return { redirect: `${urlPath}/` };
    const index = path.join(file, "index.html");
    try {
      stat = fs.statSync(index);
      file = index;
    } catch {
      return { status: 404, directory: file };
    }
  }
  if (!stat.isFile()) return { status: 404 };
  return { file, stat };
}

/**
 * Serve a static file for GET/HEAD. `notFound(res)` may render something custom. `redirectBase` prefixes directory
 * redirects (urlPath is relative to root); `htmlHeaders` are added to HTML responses only.
 */
export function serveStatic(req, res, root, urlPath, { notFound = null, query = "", headers: extra = {}, htmlHeaders = {}, redirectBase = "", htmlTransform = null } = {}) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", { allow: "GET, HEAD" });
    return;
  }
  const resolved = resolveStatic(root, urlPath);
  if (resolved.redirect) {
    res.writeHead(301, { location: redirectBase + resolved.redirect + (query ? `?${query}` : "") });
    res.end();
    return;
  }
  if (resolved.status) {
    if (resolved.status === 404 && notFound && notFound(res, resolved)) return;
    send(res, resolved.status, resolved.status === 404 ? "Not found" : "Bad request");
    return;
  }
  const { file, stat } = resolved;
  const headers = {
    "content-type": mimeOf(file),
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "last-modified": stat.mtime.toUTCString(),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
    ...(mimeOf(file).startsWith("text/html") ? htmlHeaders : {}),
  };
  if (htmlTransform && mimeOf(file).startsWith("text/html")) {
    // a page the binder adds to (the bind client for a plain site): the whole page, never a byte range of the file
    let body;
    try { body = Buffer.from(htmlTransform(fs.readFileSync(file, "utf8")), "utf8"); } catch { send(res, 500, "Could not read the page"); return; }
    res.writeHead(200, { ...headers, "accept-ranges": "none", "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  const range = parseRange(req.headers.range, stat.size);
  if (range === "unsatisfiable") {
    send(res, 416, "Range not satisfiable", { "content-range": `bytes */${stat.size}` });
    return;
  }
  if (range) {
    res.writeHead(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${stat.size}`, "content-length": range.end - range.start + 1 });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": stat.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}
