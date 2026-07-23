import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolvePrivateEnvPath } from "../../../scripts/lib/privateEnvPaths.mjs";

export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const env = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

export function firstNonEmpty(...values) {
  for (const candidate of values) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

export function hasCliFlag(args, flag) {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeSupabaseAnonKey({ fetchImpl = fetch, supabaseUrl, anonKey }) {
  if (!supabaseUrl || !anonKey) return { ok: false, status: 0, reason: "missing-input" };
  const normalized = supabaseUrl.replace(/\/+$/, "");
  try {
    const response = await fetchWithTimeout(fetchImpl, `${normalized}/auth/v1/settings`, {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
      },
    });
    return { ok: response.ok, status: response.status, reason: response.ok ? "ok" : "non-2xx" };
  } catch (error) {
    return { ok: false, status: 0, reason: String(error?.message || error) };
  }
}

export async function tryExtractAnonFromPublicBundle({ fetchImpl = fetch, baseUrl }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) return "";

  try {
    const loginResponse = await fetchWithTimeout(fetchImpl, `${normalizedBaseUrl}/login`, undefined, 8_000);
    if (!loginResponse.ok) return "";
    const loginHtml = await loginResponse.text();
    const assetMatch = loginHtml.match(/assets\/index-[^"']+\.js/);
    if (!assetMatch) return "";
    const bundleUrl = `${normalizedBaseUrl}/${assetMatch[0].replace(/^\/+/, "")}`;
    const bundleResponse = await fetchWithTimeout(fetchImpl, bundleUrl, undefined, 10_000);
    if (!bundleResponse.ok) return "";
    const bundleText = await bundleResponse.text();
    const tokenMatch = bundleText.match(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/);
    return tokenMatch?.[0] ?? "";
  } catch {
    return "";
  }
}

export async function resolveFrontendProdEnv(options = {}) {
  const {
    frontendDir,
    repoRoot,
    processEnv = process.env,
    fetchImpl = fetch,
    consoleImpl = console,
    logPrefix = "prod-env",
  } = options;
  if (!frontendDir || !repoRoot) {
    throw new Error("resolveFrontendProdEnv requires frontendDir and repoRoot.");
  }

  const prodEnv = parseEnvFile(path.join(frontendDir, ".env"));
  const frontendLocalEnv = parseEnvFile(path.join(frontendDir, ".env.local"));
  const repoProdSupabaseEnv = parseEnvFile(
    resolvePrivateEnvPath({ repoRoot, relativePath: ".env.supabase", processEnv }),
  );
  const repoLocalSupabaseEnv = parseEnvFile(
    resolvePrivateEnvPath({ repoRoot, relativePath: ".env.supabase.local", processEnv }),
  );

  const env = { ...processEnv };
  for (const [key, value] of Object.entries(prodEnv)) {
    if (!key.startsWith("VITE_")) continue;
    if (env[key] == null || String(env[key]).length === 0) {
      env[key] = value;
    }
  }

  const supabaseSource = String(env.DEV_PROD_SUPABASE_SOURCE || "prod")
    .trim()
    .toLowerCase();
  const activeSupabaseEnv = supabaseSource === "local" ? repoLocalSupabaseEnv : repoProdSupabaseEnv;

  const resolvedSupabaseUrl = firstNonEmpty(
    env.VITE_SUPABASE_URL,
    env.SUPABASE_PROJECT_URL,
    activeSupabaseEnv.VITE_SUPABASE_URL,
    activeSupabaseEnv.SUPABASE_PROJECT_URL,
    prodEnv.VITE_SUPABASE_URL,
    frontendLocalEnv.VITE_SUPABASE_URL,
  );
  const resolvedSupabaseAnonKey = firstNonEmpty(
    env.VITE_SUPABASE_ANON_KEY,
    env.SUPABASE_ANON_KEY,
    activeSupabaseEnv.VITE_SUPABASE_ANON_KEY,
    prodEnv.VITE_SUPABASE_ANON_KEY,
    frontendLocalEnv.VITE_SUPABASE_ANON_KEY,
  );
  if (resolvedSupabaseUrl) {
    env.VITE_SUPABASE_URL = resolvedSupabaseUrl;
  }
  if (resolvedSupabaseAnonKey) {
    env.VITE_SUPABASE_ANON_KEY = resolvedSupabaseAnonKey;
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().includes("SERVICE_ROLE")) {
      delete env[key];
    }
  }

  env.VITE_CONTROLLER_URL ??= "https://controller.instafy.dev";

  const autoRefreshAnon = String(env.DEV_PROD_AUTO_REFRESH_SUPABASE_ANON ?? "1")
    .trim()
    .toLowerCase();
  if (
    env.VITE_SUPABASE_URL &&
    env.VITE_SUPABASE_ANON_KEY &&
    autoRefreshAnon !== "0" &&
    autoRefreshAnon !== "false"
  ) {
    const probe = await probeSupabaseAnonKey({
      fetchImpl,
      supabaseUrl: env.VITE_SUPABASE_URL,
      anonKey: env.VITE_SUPABASE_ANON_KEY,
    });
    if (!probe.ok && (probe.status === 401 || probe.status === 403) && supabaseSource === "prod") {
      const publicSiteUrl = firstNonEmpty(env.DEV_PROD_PUBLIC_SITE_URL, "https://instafy.dev");
      const extractedToken = await tryExtractAnonFromPublicBundle({ fetchImpl, baseUrl: publicSiteUrl });
      if (extractedToken) {
        const extractedProbe = await probeSupabaseAnonKey({
          fetchImpl,
          supabaseUrl: env.VITE_SUPABASE_URL,
          anonKey: extractedToken,
        });
        if (extractedProbe.ok) {
          env.VITE_SUPABASE_ANON_KEY = extractedToken;
          consoleImpl.warn(
            `[${logPrefix}] Refreshed stale Supabase anon key from public bundle for this session (local files were not modified).`,
          );
        } else {
          consoleImpl.warn(
            `[${logPrefix}] Supabase anon key probe failed (${probe.status}) and auto-refresh candidate also failed (${extractedProbe.status}).`,
          );
        }
      } else {
        consoleImpl.warn(
          `[${logPrefix}] Supabase anon key probe failed (${probe.status}) and no replacement key could be extracted from ${publicSiteUrl}.`,
        );
      }
    }
  }

  return { env, supabaseSource };
}
