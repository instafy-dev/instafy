import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { findProjectManifest } from "./project-manifest.js";

export interface InstafyCliConfig {
  controllerUrl?: string | null;
  studioUrl?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  supabaseUrl?: string | null;
  supabaseAnonKey?: string | null;
  updatedAt?: string | null;
}

const require = createRequire(import.meta.url);
const cliVersion = (() => {
  try {
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
})();
const isStagingCli = cliVersion.includes("-staging.");

const INSTAFY_DIR = path.join(os.homedir(), ".instafy");
const CONFIG_PATH = path.join(INSTAFY_DIR, "config.json");
const PROFILES_DIR = path.join(INSTAFY_DIR, "profiles");
const DEFAULT_LOCAL_CONTROLLER_URL = "http://127.0.0.1:8788";
const DEFAULT_HOSTED_CONTROLLER_URL = "https://controller.instafy.dev";
const DEFAULT_CONTROLLER_URL = isStagingCli ? DEFAULT_HOSTED_CONTROLLER_URL : DEFAULT_LOCAL_CONTROLLER_URL;

function normalizeToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") {
    return null;
  }
  return trimmed;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/$/, "");
}

function normalizeProfileName(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error(
      `Invalid profile name "${value}". Use letters/numbers plus . _ - (max 64 chars).`,
    );
  }
  if (trimmed.includes("..")) {
    throw new Error(`Invalid profile name "${value}".`);
  }
  return trimmed;
}

export function getInstafyConfigPath(): string {
  return CONFIG_PATH;
}

export function getInstafyProfilesDirPath(): string {
  return PROFILES_DIR;
}

export function getInstafyProfileConfigPath(profile: string): string {
  const normalized = normalizeProfileName(profile);
  if (!normalized) {
    throw new Error("Profile name is required.");
  }
  return path.join(PROFILES_DIR, `${normalized}.json`);
}

export function listInstafyProfileNames(): string[] {
  try {
    const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function readInstafyCliConfig(): InstafyCliConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      controllerUrl: normalizeUrl(typeof record.controllerUrl === "string" ? record.controllerUrl : null),
      studioUrl: normalizeUrl(typeof record.studioUrl === "string" ? record.studioUrl : null),
      accessToken: normalizeToken(typeof record.accessToken === "string" ? record.accessToken : null),
      refreshToken: normalizeToken(typeof record.refreshToken === "string" ? record.refreshToken : null),
      supabaseUrl: normalizeUrl(typeof record.supabaseUrl === "string" ? record.supabaseUrl : null),
      supabaseAnonKey: normalizeToken(typeof record.supabaseAnonKey === "string" ? record.supabaseAnonKey : null),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    };
  } catch {
    return {};
  }
}

export function readInstafyProfileConfig(profile: string): InstafyCliConfig {
  const filePath = getInstafyProfileConfigPath(profile);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      controllerUrl: normalizeUrl(typeof record.controllerUrl === "string" ? record.controllerUrl : null),
      studioUrl: normalizeUrl(typeof record.studioUrl === "string" ? record.studioUrl : null),
      accessToken: normalizeToken(typeof record.accessToken === "string" ? record.accessToken : null),
      refreshToken: normalizeToken(typeof record.refreshToken === "string" ? record.refreshToken : null),
      supabaseUrl: normalizeUrl(typeof record.supabaseUrl === "string" ? record.supabaseUrl : null),
      supabaseAnonKey: normalizeToken(typeof record.supabaseAnonKey === "string" ? record.supabaseAnonKey : null),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    };
  } catch {
    return {};
  }
}

export function writeInstafyCliConfig(update: Partial<InstafyCliConfig>): InstafyCliConfig {
  const existing = readInstafyCliConfig();
  const next: InstafyCliConfig = {
    controllerUrl: normalizeUrl(update.controllerUrl ?? existing.controllerUrl ?? null),
    studioUrl: normalizeUrl(update.studioUrl ?? existing.studioUrl ?? null),
    accessToken: normalizeToken(update.accessToken ?? existing.accessToken ?? null),
    refreshToken: normalizeToken(update.refreshToken ?? existing.refreshToken ?? null),
    supabaseUrl: normalizeUrl(update.supabaseUrl ?? existing.supabaseUrl ?? null),
    supabaseAnonKey: normalizeToken(update.supabaseAnonKey ?? existing.supabaseAnonKey ?? null),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(INSTAFY_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { encoding: "utf8" });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // ignore chmod failures (windows / unusual fs)
  }

  return next;
}

export function writeInstafyProfileConfig(
  profile: string,
  update: Partial<InstafyCliConfig>,
): InstafyCliConfig {
  const filePath = getInstafyProfileConfigPath(profile);
  const existing = readInstafyProfileConfig(profile);
  const next: InstafyCliConfig = {
    controllerUrl: normalizeUrl(update.controllerUrl ?? existing.controllerUrl ?? null),
    studioUrl: normalizeUrl(update.studioUrl ?? existing.studioUrl ?? null),
    accessToken: normalizeToken(update.accessToken ?? existing.accessToken ?? null),
    refreshToken: normalizeToken(update.refreshToken ?? existing.refreshToken ?? null),
    supabaseUrl: normalizeUrl(update.supabaseUrl ?? existing.supabaseUrl ?? null),
    supabaseAnonKey: normalizeToken(update.supabaseAnonKey ?? existing.supabaseAnonKey ?? null),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), { encoding: "utf8" });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failures (windows / unusual fs)
  }
  return next;
}

export function clearInstafyCliConfig(keys?: Array<keyof InstafyCliConfig>): void {
  if (!keys || keys.length === 0) {
    try {
      fs.rmSync(CONFIG_PATH, { force: true });
    } catch {
      // ignore
    }
    return;
  }

  const existing = readInstafyCliConfig();
  const next: InstafyCliConfig = { ...existing };
  for (const key of keys) {
    next[key] = null;
  }
  writeInstafyCliConfig(next);
}

export function clearInstafyProfileConfig(
  profile: string,
  keys?: Array<keyof InstafyCliConfig>,
): void {
  const filePath = getInstafyProfileConfigPath(profile);
  if (!keys || keys.length === 0) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
    return;
  }

  const existing = readInstafyProfileConfig(profile);
  const next: InstafyCliConfig = { ...existing };
  for (const key of keys) {
    next[key] = null;
  }
  writeInstafyProfileConfig(profile, next);
}

export function resolveActiveProfileName(params?: {
  profile?: string | null;
  cwd?: string | null;
}): string | null {
  const explicit = normalizeProfileName(params?.profile ?? null);
  if (explicit) {
    return explicit;
  }
  const fromEnv = normalizeProfileName(process.env["INSTAFY_PROFILE"] ?? null);
  if (fromEnv) {
    return fromEnv;
  }
  const cwd = (params?.cwd ?? process.cwd()).trim();
  if (!cwd) {
    return null;
  }
  const manifest = findProjectManifest(cwd).manifest;
  return normalizeProfileName(manifest?.profile ?? null);
}

export function resolveConfiguredControllerUrl(params?: {
  profile?: string | null;
  cwd?: string | null;
}): string | null {
  const profile = resolveActiveProfileName(params);
  if (profile) {
    const configured = readInstafyProfileConfig(profile);
    return normalizeUrl(configured.controllerUrl ?? null);
  }
  const config = readInstafyCliConfig();
  return normalizeUrl(config.controllerUrl ?? null);
}

export function resolveConfiguredStudioUrl(params?: {
  profile?: string | null;
  cwd?: string | null;
}): string | null {
  const profile = resolveActiveProfileName(params);
  if (profile) {
    const configured = readInstafyProfileConfig(profile);
    return normalizeUrl(configured.studioUrl ?? null);
  }
  const config = readInstafyCliConfig();
  return normalizeUrl(config.studioUrl ?? null);
}

export function resolveConfiguredAccessToken(params?: {
  profile?: string | null;
  cwd?: string | null;
}): string | null {
  const profile = resolveActiveProfileName(params);
  if (profile) {
    const configured = readInstafyProfileConfig(profile);
    return normalizeToken(configured.accessToken ?? null);
  }
  const config = readInstafyCliConfig();
  return normalizeToken(config.accessToken ?? null);
}

export function resolveControllerUrl(params?: {
  controllerUrl?: string | null;
  profile?: string | null;
  cwd?: string | null;
}): string {
  const profile = resolveActiveProfileName({ profile: params?.profile ?? null, cwd: params?.cwd ?? null });
  const config = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();
  return (
    normalizeUrl(params?.controllerUrl ?? null) ??
    normalizeUrl(process.env["INSTAFY_SERVER_URL"] ?? null) ??
    normalizeUrl(process.env["CONTROLLER_BASE_URL"] ?? null) ??
    normalizeUrl(config.controllerUrl ?? null) ??
    DEFAULT_CONTROLLER_URL
  );
}

export function resolveUserAccessToken(params?: {
  accessToken?: string | null;
  profile?: string | null;
  cwd?: string | null;
}): string | null {
  const profile = resolveActiveProfileName({ profile: params?.profile ?? null, cwd: params?.cwd ?? null });
  const config = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();
  return (
    normalizeToken(params?.accessToken ?? null) ??
    normalizeToken(process.env["INSTAFY_ACCESS_TOKEN"] ?? null) ??
    normalizeToken(process.env["CONTROLLER_ACCESS_TOKEN"] ?? null) ??
    normalizeToken(process.env["RUNTIME_ACCESS_TOKEN"] ?? null) ??
    normalizeToken(process.env["SUPABASE_ACCESS_TOKEN"] ?? null) ??
    normalizeToken(config.accessToken ?? null)
  );
}

export type AccessTokenSource = "explicit" | "env" | "config" | "none";

export function resolveUserAccessTokenWithSource(params?: {
  accessToken?: string | null;
  profile?: string | null;
  cwd?: string | null;
}): { token: string | null; source: AccessTokenSource; profile: string | null } {
  const profile = resolveActiveProfileName({ profile: params?.profile ?? null, cwd: params?.cwd ?? null });
  const config = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();

  const explicit = normalizeToken(params?.accessToken ?? null);
  if (explicit) {
    return { token: explicit, source: "explicit", profile };
  }

  const envKeys = [
    "INSTAFY_ACCESS_TOKEN",
    "CONTROLLER_ACCESS_TOKEN",
    "RUNTIME_ACCESS_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
  ] as const;

  for (const key of envKeys) {
    const value = normalizeToken(process.env[key] ?? null);
    if (value) {
      return { token: value, source: "env", profile };
    }
  }

  const stored = normalizeToken(config.accessToken ?? null);
  if (stored) {
    return { token: stored, source: "config", profile };
  }

  return { token: null, source: "none", profile };
}
