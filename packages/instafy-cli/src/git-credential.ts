import { spawnSync } from "node:child_process";
import { resolveControllerUrl, resolveUserAccessToken } from "./config.js";
import { mintGitAccessToken } from "./git.js";

type CredentialRequest = {
  protocol?: string;
  host?: string;
  path?: string;
  url?: string;
  username?: string;
};

function parseCredentialRequest(raw: string): CredentialRequest {
  const request: CredentialRequest = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "protocol") request.protocol = value;
    if (key === "host") request.host = value;
    if (key === "path") request.path = value;
    if (key === "url") request.url = value;
    if (key === "username") request.username = value;
  }
  return request;
}

function normalizeHost(rawHost: string): { host: string; hostname: string } | null {
  const host = rawHost.trim();
  if (!host) return null;
  const lowered = host.toLowerCase();
  const bracketed = lowered.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) {
    return { host: lowered, hostname: bracketed[1] ?? lowered };
  }
  const lastColon = lowered.lastIndexOf(":");
  if (lastColon > 0) {
    const possiblePort = lowered.slice(lastColon + 1);
    if (/^\d+$/.test(possiblePort)) {
      return { host: lowered, hostname: lowered.slice(0, lastColon) };
    }
  }
  return { host: lowered, hostname: lowered };
}

function resolveRequestHost(request: CredentialRequest): string | null {
  if (request.host?.trim()) return request.host.trim();
  if (request.url?.trim()) {
    try {
      const parsed = new URL(request.url.trim());
      return parsed.host;
    } catch {
      return null;
    }
  }
  return null;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedGitHost(rawHost: string | null): boolean {
  if (!rawHost) return false;
  const normalized = normalizeHost(rawHost);
  if (!normalized) return false;

  const allowHosts = splitCsv(process.env["INSTAFY_GIT_HOSTS"]);
  if (allowHosts.includes(normalized.host) || allowHosts.includes(normalized.hostname)) {
    return true;
  }

  // Safe-by-default allow-list: Instafy domains and local dev.
  if (
    normalized.hostname === "localhost" ||
    normalized.hostname === "127.0.0.1" ||
    normalized.hostname === "::1" ||
    normalized.hostname === "host.docker.internal"
  ) {
    return true;
  }

  // Local dev stack defaults to docker-compose service names.
  if (normalized.hostname === "git-edge" || normalized.hostname.startsWith("git-shard")) {
    return true;
  }

  return normalized.hostname.endsWith(".instafy.dev");
}

function normalizeRepoName(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  const first = trimmed.split("/")[0] ?? "";
  if (!first.endsWith(".git")) return null;
  const withoutSuffix = first.slice(0, -".git".length);
  return withoutSuffix || null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function parseProjectIdFromUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const repo = normalizeRepoName(parsed.pathname);
    return repo && isUuid(repo) ? repo : null;
  } catch {
    // Not a WHATWG URL (e.g. scp-like).
  }

  const scpLike = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scpLike) {
    const repo = normalizeRepoName(scpLike[2] ?? "");
    return repo && isUuid(repo) ? repo : null;
  }

  return null;
}

function resolveProjectIdFromRequest(request: CredentialRequest): string | null {
  const fromPath = request.path ? normalizeRepoName(request.path) : null;
  if (fromPath && isUuid(fromPath)) return fromPath;

  const fromUrl = request.url ? parseProjectIdFromUrl(request.url) : null;
  if (fromUrl) return fromUrl;

  return null;
}

function resolveProjectIdFromGitRemotes(host: string | undefined | null): string | null {
  const result = spawnSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  const lines = (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s+/, 2);
    const url = parts[1] ?? "";
    if (!url) continue;

    if (host) {
      try {
        const parsed = new URL(url);
        if (parsed.host !== host) continue;
      } catch {
        // ignore non-url remotes when host is known
        continue;
      }
    }

    const projectId = parseProjectIdFromUrl(url);
    if (projectId) return projectId;
  }
  return null;
}

export async function runGitCredentialHelper(operation: string): Promise<void> {
  const normalized = (operation ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("git credential helper requires an operation (get|store|erase)");
  }

  // We mint tokens on demand; no persistence needed.
  if (normalized === "store" || normalized === "erase") {
    return;
  }
  if (normalized !== "get") {
    throw new Error(`unsupported git credential operation: ${operation}`);
  }

  const stdin = await new Promise<string>((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.resume();
  });

  const request = parseCredentialRequest(stdin);
  const requestHost = resolveRequestHost(request);
  if (!isAllowedGitHost(requestHost)) {
    return;
  }
  const projectId =
    resolveProjectIdFromRequest(request) ??
    resolveProjectIdFromGitRemotes(requestHost);
  if (!projectId) {
    return;
  }

  const controllerUrl = resolveControllerUrl({ controllerUrl: null });
  const userAccessToken = resolveUserAccessToken({ accessToken: null });
  if (!userAccessToken) {
    throw new Error("Not authenticated. Run `instafy login` first.");
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  const minted = await mintGitAccessToken({
    controllerUrl,
    controllerAccessToken: userAccessToken,
    projectId,
    scopes: ["git.read", "git.write"],
    signal: abort.signal,
  }).finally(() => clearTimeout(timeout));

  process.stdout.write(`username=instafy\npassword=${minted.token}\n`);
}
