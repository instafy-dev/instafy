// SPDX-License-Identifier: AGPL-3.0-only
//
// safeFetch: a small GET for script handlers that refuses SSRF targets.
// - https only (http is allowed only with allowLocal, for local fixtures);
// - no credentials in the URL;
// - every DNS answer is checked, and the checked address is the one the socket connects to
//   (custom `lookup`), so a rebinding answer cannot slip in between check and connect;
// - IP literals are checked directly (Node skips `lookup` for them);
// - redirects are followed by hand (max 5) and every hop is checked again;
// - body capped (default 8 MB), gzip/deflate/br decoded, overall timeout.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.code = "policy";
  }
}

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.code = "upstream";
    this.status = status;
  }
}

function v4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

function expandV6(ip) {
  let addr = ip.toLowerCase().split("%")[0];
  let tail = [];
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    tail = [(n >>> 16).toString(16), (n & 0xffff).toString(16)];
    addr = addr.slice(0, -v4[1].length).replace(/:$/, "") || ":";
    if (addr === ":") addr = "::";
  }
  const [head, rest] = addr.includes("::") ? addr.split("::") : [addr, null];
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = rest ? rest.split(":").filter(Boolean) : [];
  const fill = 8 - left.length - right.length - tail.length;
  const parts = rest === null ? [...left, ...tail] : [...left, ...Array(Math.max(fill, 0)).fill("0"), ...right, ...tail];
  return parts.map((p) => parseInt(p, 16) || 0);
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public addresses. */
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family !== 6) return true;
  const w = expandV6(ip);
  if (w.length !== 8) return true;
  if (w.every((x) => x === 0)) return true;                                   // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;          // ::1
  const embedded = `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isPrivateV4(embedded); // ::ffff:a.b.c.d
  if (w.slice(0, 6).every((x) => x === 0)) return true;                        // ::a.b.c.d (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b) return isPrivateV4(embedded);          // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true;                                 // fc00::/7 ULA
  if ((w[0] & 0xffc0) === 0xfe80) return true;                                 // fe80::/10 link-local
  if ((w[0] & 0xff00) === 0xff00) return true;                                 // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;                         // documentation
  if (w[0] === 0x2001 && w[1] === 0x0000) return true;                         // Teredo
  if ((w[0] & 0xffc0) === 0xfec0) return true;                                 // fec0::/10 site-local
  if (w[0] === 0x2002) return isPrivateV4(`${w[1] >> 8}.${w[1] & 255}.${w[2] >> 8}.${w[2] & 255}`); // 6to4
  return false;
}

/** Throws PolicyError unless the URL is one a handler may fetch. */
export function checkUrl(raw, { allowLocal = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PolicyError("Not a valid URL");
  }
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) {
    throw new PolicyError("Only https:// URLs can be read");
  }
  if (url.username || url.password) throw new PolicyError("URLs with credentials are refused");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowLocal) {
    if (net.isIP(host) && isPrivateAddress(host)) throw new PolicyError("Private, loopback and LAN addresses are refused");
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) {
      throw new PolicyError("Local host names are refused");
    }
  }
  return url;
}

function guardedLookup(allowLocal) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, family: options?.family || 0, hints: options?.hints }, (error, addresses) => {
      if (error) return callback(error);
      if (!allowLocal) {
        const blocked = addresses.find((a) => isPrivateAddress(a.address));
        if (blocked) {
          const err = new PolicyError(`${hostname} resolves to a private address`);
          return callback(err);
        }
      }
      if (options?.all) return callback(null, addresses);
      const first = addresses[0];
      return callback(null, first.address, first.family);
    });
  };
}

function requestOnce(url, { allowLocal, headers, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers,
        lookup: guardedLookup(allowLocal),
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: res.headers.location, headers: res.headers });
          return;
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            stream.destroy();
            reject(new UpstreamError(`Page is larger than ${Math.round(maxBytes / 1e6)} MB`, status));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new UpstreamError("Timed out", 0)));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(raw, opts = {}) {
  const {
    allowLocal = false,
    maxBytes = 8_000_000,
    timeoutMs = 20_000,
    maxRedirects = 5,
    userAgent = "Mozilla/5.0 (compatible; instafy-bind/0.1; +https://instafy.dev)",
  } = opts;
  const headers = {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.8",
    "accept-encoding": "gzip, deflate, br",
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = checkUrl(raw, { allowLocal });
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await requestOnce(url, { allowLocal, headers, timeoutMs, maxBytes, signal: controller.signal });
      if (res.location) {
        url = checkUrl(new URL(res.location, url).toString(), { allowLocal });
        continue;
      }
      if (res.status >= 400) throw new UpstreamError(`HTTP ${res.status} from ${url.hostname}`, res.status);
      return { status: res.status, url: url.toString(), headers: res.headers, text: res.text };
    }
    throw new UpstreamError("Too many redirects", 0);
  } catch (error) {
    if (error?.name === "AbortError") throw new UpstreamError("Timed out", 0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
