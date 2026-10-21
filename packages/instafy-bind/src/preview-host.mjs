// Preview mode (`serve --preview`): serve a bound site inside Studio's preview card without a viewer token.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Why this is safe. `instafy preview open --port N` connects a private tunnel to 127.0.0.1:N. The tunnel broker's
// Traefik only routes that tunnel through a capability host `p-<26 base32 label>--<32 hex tunnel id>.<preview
// domain>`, behind the broker's forwardAuth, which lets through only space members holding a live per-Open session
// (tunnel-broker ingress.rs; runtime-controller previews/sessions.rs). Traefik keeps the Host header and the rathole
// hop is plain TCP, so the binder sees that capability host. The site backend holds no credential (see
// SITE-BACKEND-CONTRACT.md): forwardAuth on the capability host is the auth, so the binder needs no token of its own.
//
// What the binder still checks, because without a token anything that reaches the port could act:
// - it listens on loopback only (enforced by createBinder), so only this runtime's own processes and its tunnels
//   reach it;
// - the Host header is a loopback name at the binder's port, or a capability host `p-<label>--<id>.<suffix>` where
//   <id> is a preview `instafy preview open` recorded for this port (~/.instafy/cli-preview-state.json) AND <suffix>
//   is exactly the preview domain (and port) the controller told the CLI that preview is viewed under (`hostSuffix`).
//   The tunnel id alone is not a secret: every member's frame address carries it and it leaks as a Referer, so a
//   DNS-rebinding page named `p-<any label>--<id>.attacker.example` could otherwise pose as the preview host. The
//   attacker cannot serve a page from the real preview domain, so pinning the domain is what stops rebinding. A state
//   entry without a hostSuffix (an older CLI) is never accepted. A public tunnel (`instafy tunnel`, Host
//   `<uuid>.<tunnel domain>`) or any other name gets 421;
// - intents still need Origin == Host (same origin) and a JSON body (CORS preflight), as with a token;
// - frame messages (Ask Octo, location, follow mode) are taken only from the Studio origin `instafy preview open`
//   recorded for that preview (`studioOrigin`, from the controller): the capability host sends
//   `frame-ancestors 'self' <studio origin>` and the bind client trusts no other parent. The label is a bearer that
//   also leaks in Origin headers, so without this any page that framed the preview URL could act as its host. A
//   preview without a recorded Studio origin is still shown, but its page takes no host messages at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The capability host the broker routes private previews by (Traefik HostRegexp), plus an optional port. */
export const PREVIEW_HOST_RE = /^p-[a-z2-7]{26}--([0-9a-f]{32})\.([a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?)$/;

/** Where the Instafy CLI records the previews it opened (instafy-cli src/preview.ts previewStateFile). */
export function defaultPreviewStateFile() {
  return path.join(os.homedir(), ".instafy", "cli-preview-state.json");
}

/** The tunnel id (32 lowercase hex) of a capability Host header, or null. */
export function previewTunnelOf(hostHeader) {
  return previewHostParts(hostHeader)?.tunnel ?? null;
}

/** `{ tunnel, suffix }` of a capability Host header (suffix = the domain and any port after the first label), or null. */
export function previewHostParts(hostHeader) {
  const match = PREVIEW_HOST_RE.exec(String(hostHeader || "").trim().toLowerCase());
  return match ? { tunnel: match[1], suffix: match[2] } : null;
}

const normalizeSuffix = (raw) => {
  const suffix = String(raw || "").trim().toLowerCase().replace(/^\.+/, "");
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/.test(suffix) ? suffix : null;
};

const normalizeTunnelId = (raw) => {
  const hex = String(raw || "").trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
};

const normalizeOrigin = (raw) => {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch {
    return null;
  }
};

/**
 * The previews opened for a local port, read from the CLI's state file: a Map of tunnel id → Map of the host suffixes
 * it is viewed under → the Studio origins that frame it (empty when unknown). Entries without a hostSuffix are left out. The file is small and is written by `instafy preview open`
 * after the binder starts, so it is read on use (cached until it changes).
 */
export function previewTunnelReader(file = defaultPreviewStateFile()) {
  let cacheKey = null;
  let cached = [];
  return function tunnelsForPort(port) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cacheKey = null;
      cached = [];
      return new Map();
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== cacheKey) {
      cacheKey = key;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        cached = Array.isArray(parsed?.previews) ? parsed.previews.filter((p) => p && typeof p === "object") : [];
      } catch {
        cached = [];
      }
    }
    const previews = new Map();
    for (const entry of cached) {
      if (Number(entry.localPort) !== Number(port)) continue;
      const id = normalizeTunnelId(entry.previewId);
      const suffix = normalizeSuffix(entry.hostSuffix);
      if (!id || !suffix) continue;
      if (!previews.has(id)) previews.set(id, new Map());
      const suffixes = previews.get(id);
      if (!suffixes.has(suffix)) suffixes.set(suffix, new Set());
      const studio = normalizeOrigin(entry.studioOrigin);
      if (studio) suffixes.get(suffix).add(studio);
    }
    return previews;
  };
}
