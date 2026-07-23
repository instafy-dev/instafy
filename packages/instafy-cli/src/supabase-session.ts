import {
  readInstafyCliConfig,
  readInstafyProfileConfig,
  resolveActiveProfileName,
  writeInstafyCliConfig,
  writeInstafyProfileConfig,
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
  return (
    normalizeUrl(configured) ??
    normalizeUrl(process.env["SUPABASE_URL"]) ??
    normalizeUrl(process.env["VITE_SUPABASE_URL"]) ??
    normalizeUrl(process.env["SUPABASE_PROJECT_URL"]) ??
    null
  );
}

function resolveSupabaseAnonKey(configured: string | null): string | null {
  return (
    normalizeToken(configured) ??
    normalizeToken(process.env["SUPABASE_ANON_KEY"]) ??
    normalizeToken(process.env["VITE_SUPABASE_ANON_KEY"]) ??
    null
  );
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
  const response = await fetch(`${params.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: params.supabaseAnonKey,
      authorization: `Bearer ${params.supabaseAnonKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ refresh_token: params.refreshToken }),
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
}): Promise<RefreshedSession | null> {
  const profile = resolveActiveProfileName(params);
  const config = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();

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

  const next = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken,
    supabaseUrl: refreshed.supabaseUrl,
    supabaseAnonKey: refreshed.supabaseAnonKey,
  };

  if (profile) {
    writeInstafyProfileConfig(profile, next);
  } else {
    writeInstafyCliConfig(next);
  }

  return refreshed;
}

