// SPDX-License-Identifier: AGPL-3.0-only
//
// What every `instafy preview` command needs to know about a site served in this space: whether a port may be shown
// at all, and whether anything answers on it. Nothing here calls a server.
import http from "node:http";

export const PREVIEW_EXIT_NOT_LISTENING = 2;
export const PREVIEW_EXIT_PORT_NOT_ALLOWED = 3;

export class PreviewCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

// Ports that belong to Instafy, never to a site. Each default is always refused, and so is the port an override of
// the same setting names, so moving a service never makes its port previewable. 9222 is Chromium's conventional
// DevTools port and 9225 the browser stream sender's; neither has a setting.
type ReservedPort = { env?: string; kind?: "port" | "bind" | "url"; port: number };
const RESERVED_PORTS: ReservedPort[] = [
  { env: "INSTAFY_VNC_PORT", kind: "port", port: 5900 },
  { env: "INSTAFY_PROVIDER_HOST_URL", kind: "url", port: 8789 },
  { env: "PROXY_BASE_URL", kind: "url", port: 8789 },
  { port: 9222 },
  { env: "INSTAFY_PLAYWRIGHT_CDP_PORT", kind: "port", port: 9223 },
  { env: "INSTAFY_PLAYWRIGHT_CDP_URL", kind: "url", port: 9223 },
  { port: 9225 },
  { env: "INSTAFY_BROWSER_EGRESS_PROXY_BIND", kind: "bind", port: 9226 },
  { env: "INSTAFY_PERSONAL_BROWSER_CONTROL_URL", kind: "url", port: 43127 },
  { env: "ORIGIN_BIND_PORT", kind: "port", port: 54332 },
];
/** Comma-separated extra ports to refuse. */
export const PREVIEW_DENY_PORTS_ENV = "INSTAFY_PREVIEW_DENY_PORTS";
const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
const PROBE_TIMEOUT_MS = 5_000;

function portNumber(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= MAX_PREVIEW_PORT ? port : null;
}

function portFromSetting(kind: NonNullable<ReservedPort["kind"]>, raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (kind === "port") return portNumber(value);
  if (kind === "bind") return portNumber(value.slice(value.lastIndexOf(":") + 1));
  try {
    const url = new URL(value);
    return portNumber(url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""));
  } catch {
    return null;
  }
}

/** Every port a preview may not use under this environment. A malformed extra list refuses everything (exit 3). */
export function reservedPreviewPorts(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const denied = new Set<number>();
  for (const entry of RESERVED_PORTS) {
    denied.add(entry.port);
    const raw = entry.env ? env[entry.env] : undefined;
    const port = entry.kind && raw ? portFromSetting(entry.kind, raw) : null;
    if (port !== null) denied.add(port);
  }
  for (const raw of (env[PREVIEW_DENY_PORTS_ENV] ?? "").split(",")) {
    if (!raw.trim()) continue;
    const port = portNumber(raw.trim());
    if (port === null) {
      throw new PreviewCommandError(
        `${PREVIEW_DENY_PORTS_ENV} has an entry that is not a port (${JSON.stringify(raw.trim().slice(0, 20))}), so no port is allowed until it is fixed.`,
        PREVIEW_EXIT_PORT_NOT_ALLOWED,
      );
    }
    denied.add(port);
  }
  return denied;
}

export function parsePreviewPort(raw: string | number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(value) || value < MIN_PREVIEW_PORT || value > MAX_PREVIEW_PORT) {
    throw new PreviewCommandError(
      `Port must be a number from ${MIN_PREVIEW_PORT} to ${MAX_PREVIEW_PORT}.`,
      PREVIEW_EXIT_PORT_NOT_ALLOWED,
    );
  }
  if (reservedPreviewPorts(env).has(value)) {
    throw new PreviewCommandError(
      `Port ${value} is reserved for Instafy and cannot be previewed. Serve the site on another port.`,
      PREVIEW_EXIT_PORT_NOT_ALLOWED,
    );
  }
  return value;
}

export type LocalSiteProbe = {
  /** an HTTP answer below 500 */
  listening: boolean;
  /** set for any HTTP answer, a 5xx included */
  status: number | null;
  reason?: string;
  /** the loopback host that answered, as it goes in a URL: 127.0.0.1 or [::1] */
  host: string | null;
};

/** The loopback hosts tried, in order: IPv4 first, then IPv6 for servers bound to `localhost` that resolves to ::1. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

export function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function probeHost(host: string, port: number, sitePath: string, timeoutMs: number): Promise<LocalSiteProbe & { code?: string }> {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: sitePath, agent: false, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      request.destroy();
      resolve({ listening: status > 0 && status < 500, status, reason: `HTTP ${status}`, host: urlHost(host) });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ listening: false, status: null, reason: `no answer within ${timeoutMs / 1000} s`, host: null, code: "TIMEOUT" });
    });
    request.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      resolve({ listening: false, status: null, reason: code ?? error.message, host: null, code });
    });
  });
}

/**
 * One GET to http://127.0.0.1:<port><path>, then to http://[::1]:<port><path> when nothing takes the IPv4 connection.
 * A server that accepts but does not answer in time is not retried on IPv6.
 */
export async function probeLocalSite(
  port: number,
  sitePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  hosts: readonly string[] = LOOPBACK_HOSTS,
): Promise<LocalSiteProbe> {
  const tried: string[] = [];
  let last: LocalSiteProbe = { listening: false, status: null, reason: "no answer", host: null };
  for (const host of hosts) {
    const { code, ...result } = await probeHost(host, port, sitePath, timeoutMs);
    if (result.status !== null) return result;
    tried.push(`${urlHost(host)}: ${result.reason}`);
    last = { ...result, reason: tried.join(", ") };
    if (code === "TIMEOUT") break;
  }
  return last;
}
