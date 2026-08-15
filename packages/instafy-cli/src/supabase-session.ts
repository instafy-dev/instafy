import {
  readInstafyCliConfig,
  readInstafyProfileConfig,
  replaceStoredAuthSessionIfUnchanged,
  resolveActiveProfileName,
  type StoredAuthSessionSnapshot,
} from "./config.js";

function normalizeToken(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return null;
  return trimmed;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

function resolveSupabaseUrl(configured: string | null): string | null {
  return normalizeUrl(configured);
}

function resolveSupabaseAnonKey(configured: string | null): string | null {
  return normalizeToken(configured);
}

type RefreshedSession = {
  accessToken: string;
  refreshToken: string | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

async function refreshSupabaseSession(params: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  refreshToken: string;
}): Promise<RefreshedSession | null> {
  const baseUrl = new URL(`${params.supabaseUrl.replace(/\/$/, "")}/`);
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username ||
    baseUrl.password
  ) {
    return null;
  }
  const timeoutValue = Number(process.env["INSTAFY_HTTP_TIMEOUT_MS"] ?? 60_000);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 60_000;
  const response = await fetch(new URL("auth/v1/token?grant_type=refresh_token", baseUrl), {
    method: "POST",
    headers: {
      apikey: params.supabaseAnonKey,
      authorization: `Bearer ${params.supabaseAnonKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ refresh_token: params.refreshToken }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof body["access_token"] === "string" ? (body["access_token"] as string).trim() : "";
  if (!accessToken) {
    return null;
  }
  const refreshToken = typeof body["refresh_token"] === "string" ? (body["refresh_token"] as string).trim() : null;
  return {
    accessToken,
    refreshToken,
    supabaseUrl: params.supabaseUrl,
    supabaseAnonKey: params.supabaseAnonKey,
  };
}

export async function refreshStoredSupabaseSession(params?: {
  profile?: string | null;
  cwd?: string | null;
  expected?: StoredAuthSessionSnapshot;
}): Promise<RefreshedSession | null> {
  const profile = resolveActiveProfileName(params);
  const config = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();
  const snapshot: StoredAuthSessionSnapshot = {
    controllerUrl: config.controllerUrl ?? null,
    accessToken: config.accessToken ?? null,
    refreshToken: config.refreshToken ?? null,
    supabaseUrl: config.supabaseUrl ?? null,
    supabaseAnonKey: config.supabaseAnonKey ?? null,
  };
  if (
    params?.expected &&
    (snapshot.controllerUrl !== params.expected.controllerUrl ||
      snapshot.accessToken !== params.expected.accessToken ||
      snapshot.refreshToken !== params.expected.refreshToken ||
      snapshot.supabaseUrl !== params.expected.supabaseUrl ||
      snapshot.supabaseAnonKey !== params.expected.supabaseAnonKey)
  ) {
    return null;
  }

  const refreshToken = normalizeToken(config.refreshToken ?? null);
  if (!refreshToken) {
    return null;
  }

  const supabaseUrl = resolveSupabaseUrl(config.supabaseUrl ?? null);
  const supabaseAnonKey = resolveSupabaseAnonKey(config.supabaseAnonKey ?? null);
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  const refreshed = await refreshSupabaseSession({
    supabaseUrl,
    supabaseAnonKey,
    refreshToken,
  });
  if (!refreshed) {
    return null;
  }

  const next: StoredAuthSessionSnapshot = {
    controllerUrl: snapshot.controllerUrl,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken,
    supabaseUrl: refreshed.supabaseUrl,
    supabaseAnonKey: refreshed.supabaseAnonKey,
  };
  const stored = replaceStoredAuthSessionIfUnchanged({
    profile,
    expected: snapshot,
    update: next,
  });
  return stored ? refreshed : null;
}
