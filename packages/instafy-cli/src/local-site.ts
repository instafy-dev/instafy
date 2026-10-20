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

// Ports that belong to Instafy, never to a site: VNC, the provider host, the browser's DevTools ports, the loopback
// MCP proxy and the origin. PREVIEW_DENY_PORTS (comma separated) adds more.
const DENIED_PREVIEW_PORTS = [5900, 8789, 9222, 9223, 9225, 9226, 43127, 54332];
const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
const PROBE_TIMEOUT_MS = 5_000;

function deniedPreviewPorts(env: NodeJS.ProcessEnv): Set<number> {
  const denied = new Set(DENIED_PREVIEW_PORTS);
  for (const raw of (env.PREVIEW_DENY_PORTS ?? "").split(",")) {
    const port = Number(raw.trim());
    if (raw.trim() && Number.isInteger(port)) denied.add(port);
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
  if (deniedPreviewPorts(env).has(value)) {
    throw new PreviewCommandError(
      `Port ${value} is reserved for Instafy and cannot be previewed. Serve the site on another port.`,
      PREVIEW_EXIT_PORT_NOT_ALLOWED,
    );
  }
  return value;
}

export type LocalSiteProbe = { listening: boolean; status: number | null; reason?: string };

/** One GET to http://127.0.0.1:<port><path>. `listening` is false for a 5xx; `status` is set for any HTTP answer. */
export function probeLocalSite(port: number, sitePath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<LocalSiteProbe> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: sitePath, agent: false, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      request.destroy();
      resolve({ listening: status > 0 && status < 500, status, reason: `HTTP ${status}` });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ listening: false, status: null, reason: `no answer within ${timeoutMs / 1000} s` });
    });
    request.on("error", (error) => {
      resolve({ listening: false, status: null, reason: (error as NodeJS.ErrnoException).code ?? error.message });
    });
  });
}
