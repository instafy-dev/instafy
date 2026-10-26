// SSRF guard: URL params and handler fetches go only to public http(s) addresses unless --allow-local.
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPrivateV4(ip) {
  const value = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function expandV6(ip) {
  let address = ip.toLowerCase().replace(/%.*$/, "");
  let tail = [];
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    tail = [(n >>> 16).toString(16), (n & 0xffff).toString(16)];
    address = address.slice(0, -v4[1].length).replace(/:$/, "") || ":";
    if (address === ":") address = "::";
  }
  const [head, rest] = address.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = rest !== undefined ? (rest ? rest.split(":").filter(Boolean) : []) : null;
  const known = left.length + (right ? right.length : 0) + tail.length;
  const middle = right === null ? [] : Array(Math.max(0, 8 - known)).fill("0");
  return [...left, ...middle, ...(right || []), ...tail].map((h) => parseInt(h, 16) || 0);
}

function isPrivateV6(ip) {
  const g = expandV6(ip);
  if (g.length !== 8) return true;
  const allZeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(8)) return true; // ::
  if (allZeroUpTo(7) && g[7] === 1) return true; // ::1
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateV4(embedded()); // ::ffff:a.b.c.d
  if (allZeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(embedded()); // ::ffff:0:a.b.c.d (SIIT translated)
  if (allZeroUpTo(6)) return true; // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embedded()); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): a network's own translator
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // 2001::/32 Teredo (tunnels to arbitrary IPv4)
  if (g[0] === 0x2002) return isPrivateV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 2002::/16 6to4
  return false;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and documentation addresses. */
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
}

const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|lan|home|intranet|localdomain)$/i;

/** True for a host name that names this machine or a local network (localhost, *.local, a single label, …). */
export function isLocalHostName(host) {
  // A fully qualified name may end in a dot ("localhost.", "router.lan."); it names the same host.
  // Trimmed with a loop, not /\.+$/, which backtracks quadratically on a long run of dots.
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end -= 1;
  const name = host.slice(0, end);
  return LOCAL_NAME_RE.test(name) || !name.includes(".");
}

/**
 * Check that a URL points at a public http(s) host. Resolves DNS names.
 * Returns {ok: true, addresses} or {ok: false, reason}.
 */
export async function checkPublicUrl(raw, { allowLocal = false, lookup = dns.promises.lookup } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "only http(s) URLs are allowed" };
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (allowLocal) return { ok: true, addresses: [] };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    return isPrivateAddress(host) ? { ok: false, reason: `${host} is a private or local address` } : { ok: true, addresses: [host] };
  }
  if (isLocalHostName(host)) return { ok: false, reason: `${host} is a local host name` };
  let addresses;
  try {
    addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch (error) {
    return { ok: false, reason: `${host} does not resolve (${error.code || error.message})` };
  }
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) return { ok: false, reason: `${host} resolves to a private address` };
  return { ok: true, addresses };
}

/**
 * Every string in `value` that its schema marks format: uri, walking properties, additionalProperties,
 * items and oneOf/anyOf/allOf branches. Returns [{path, value}].
 */
export function uriParams(schema, value, at = "") {
  const out = [];
  if (!schema || typeof schema !== "object") return out;
  const branches = [...(schema.oneOf || []), ...(schema.anyOf || []), ...(schema.allOf || [])];
  if (typeof value === "string" && (schema.format === "uri" || branches.some((b) => b?.format === "uri"))) {
    out.push({ path: at || "$", value });
    return out;
  }
  if (Array.isArray(value)) {
    const items = schema.items && typeof schema.items === "object" ? schema.items : null;
    if (items) value.forEach((entry, i) => out.push(...uriParams(items, entry, `${at}[${i}]`)));
  } else if (value && typeof value === "object") {
    const props = schema.properties || {};
    for (const [key, entry] of Object.entries(value)) {
      const sub = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : typeof schema.additionalProperties === "object" ? schema.additionalProperties : null;
      if (sub) out.push(...uriParams(sub, entry, at ? `${at}.${key}` : key));
    }
  }
  for (const branch of branches) if (typeof value !== "string") out.push(...uriParams(branch, value, at));
  return out;
}

/**
 * Check every param the schema marks format: uri (nested ones too): public http(s) only, and inside
 * `allowedOrigins` when that list is given. Returns null or a reason.
 */
export async function checkUriParams(paramsSchema, params, { allowedOrigins = null, ...options } = {}) {
  const seen = new Set();
  for (const { path: at, value } of uriParams(paramsSchema, params)) {
    if (seen.has(at)) continue;
    seen.add(at);
    if (allowedOrigins && allowedOrigins.length && !originAllowed(value, allowedOrigins)) {
      let origin = value;
      try {
        origin = new URL(value).origin;
      } catch {
        // reported as is
      }
      return `${at}: ${String(origin).slice(0, 80)} is not in allowed_origins`;
    }
    const result = await checkPublicUrl(value, options);
    if (!result.ok) return `${at}: ${result.reason}`;
  }
  return null;
}

/** The origins of an intent's URL params, as allowed_origins patterns (used when an agent intent declares none). */
export function uriParamOrigins(paramsSchema, params) {
  const origins = new Set();
  for (const { value } of uriParams(paramsSchema, params)) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // not a URL
    }
  }
  return [...origins];
}

/** A dns.lookup wrapper that refuses private addresses at connect time (covers DNS rebinding). */
function guardedLookup(allowLocal) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (!allowLocal) {
        const blocked = list.find((entry) => isPrivateAddress(entry.address));
        if (blocked) {
          const refusal = new Error(`refusing to connect to private address for ${hostname}`);
          refusal.code = "EPRIVATE";
          return callback(refusal);
        }
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
/** Response headers up to this size are read (Node's default, 16 KB, is less than some shops send). */
export const MAX_HEADER_BYTES = 128 * 1024;

/**
 * Fetch a public URL for script handlers. Redirects are followed manually and re-checked (and passed to `checkHop`);
 * credential headers are dropped when a redirect changes origin.
 * Resolves {ok, status, url, headers, body: Buffer, text(): Promise<string>, json(): Promise<any>}.
 */
export async function safeFetch(raw, { allowLocal = false, method = "GET", headers: initialHeaders = {}, maxBytes = 5 * 1024 * 1024, timeoutMs = 20_000, maxRedirects = 5, followRedirects = true, checkHop = null } = {}) {
  let current = raw;
  let headers = { ...initialHeaders };
  let firstOrigin = null;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await checkPublicUrl(current, { allowLocal });
    if (!check.ok) throw Object.assign(new Error(`blocked: ${check.reason}`), { code: "policy" });
    // A caller's own rule for every URL it would read, the first one and each redirect target (kit.fetch: robots.txt).
    // It throws to refuse.
    if (checkHop) await checkHop(current, hop);
    const url = new URL(current);
    firstOrigin ??= url.origin;
    if (url.origin !== firstOrigin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.includes(name.toLowerCase())));
    }
    const response = await new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const request = lib.request(url, {
        method,
        headers: { "user-agent": "instafy-bind/0.1", ...headers },
        lookup: net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : guardedLookup(allowLocal),
        timeout: timeoutMs,
        maxHeaderSize: MAX_HEADER_BYTES,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(Object.assign(new Error(`response larger than ${maxBytes} bytes`), { code: "upstream" }));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      request.on("timeout", () => request.destroy(Object.assign(new Error("request timed out"), { code: "timeout" })));
      request.on("error", (error) => {
        // Say which site failed; a handler that does not catch it still reports something readable.
        if (error.code === "upstream" || error.code === "timeout" || error.code === "EPRIVATE") return reject(error);
        reject(Object.assign(new Error(`could not read ${url.hostname}: ${error.reason || error.message}`), { code: "upstream", cause: error }));
      });
      request.end();
    });
    if (followRedirects && [301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      current = new URL(response.headers.location, url).toString();
      continue;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      url: url.toString(),
      headers: response.headers,
      body: response.body,
      text: async () => response.body.toString("utf8"),
      json: async () => JSON.parse(response.body.toString("utf8")),
    };
  }
  throw Object.assign(new Error("too many redirects"), { code: "upstream" });
}

/** Match an origin against bound.json allowed_origins patterns like "https://*" or "https://*.example.com". */
export function originAllowed(raw, patterns) {
  if (!patterns || patterns.length === 0) return true;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return patterns.some((pattern) => {
    const match = pattern.match(/^(https?):\/\/([^:/]+)(?::(\d+))?$/);
    if (!match) return false;
    const [, scheme, hostPattern, port] = match;
    if (`${scheme}:` !== url.protocol) return false;
    const actualPort = url.port || (scheme === "https" ? "443" : "80");
    if (actualPort !== (port || (scheme === "https" ? "443" : "80"))) return false;
    if (hostPattern === "*") return true;
    if (hostPattern.startsWith("*.")) {
      const suffix = hostPattern.slice(1).toLowerCase();
      return url.hostname.toLowerCase().endsWith(suffix);
    }
    return url.hostname.toLowerCase() === hostPattern.toLowerCase();
  });
}
