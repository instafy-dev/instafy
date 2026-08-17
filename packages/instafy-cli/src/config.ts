import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
const CONFIG_LOCK_STALE_MS = 30_000;
const CONFIG_LOCK_WAIT_MS = 5_000;

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

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mergeConfig(
  existing: InstafyCliConfig,
  update: Partial<InstafyCliConfig>,
): InstafyCliConfig {
  const value = <K extends keyof InstafyCliConfig>(key: K): InstafyCliConfig[K] =>
    hasOwn(update, key) ? update[key] : existing[key];
  return {
    controllerUrl: normalizeUrl(value("controllerUrl") ?? null),
    studioUrl: normalizeUrl(value("studioUrl") ?? null),
    accessToken: normalizeToken(value("accessToken") ?? null),
    refreshToken: normalizeToken(value("refreshToken") ?? null),
    supabaseUrl: normalizeUrl(value("supabaseUrl") ?? null),
    supabaseAnonKey: normalizeToken(value("supabaseAnonKey") ?? null),
    updatedAt: new Date().toISOString(),
  };
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function withConfigWriteLock<T>(filePath: string, action: () => T): T {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  let descriptor: number | null = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const lockStat = fs.statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > CONFIG_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update Instafy CLI config: ${filePath}`);
      }
      sleepSync(20);
    }
  }

  try {
    return action();
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A stale-lock recovery may already have removed it.
      }
    }
  }
}

function writeConfigAtomically(filePath: string, config: InstafyCliConfig): void {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore chmod failures (windows / unusual fs)
    }
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore best-effort temp cleanup
    }
  }
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
  return withConfigWriteLock(CONFIG_PATH, () => {
    const next = mergeConfig(readInstafyCliConfig(), update);
    writeConfigAtomically(CONFIG_PATH, next);
    return next;
  });
}

export function writeInstafyControllerUrl(controllerUrl: string): InstafyCliConfig {
  const parsed = new URL(controllerUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("controller-url must be an HTTP(S) URL without embedded credentials");
  }
  const normalizedControllerUrl = parsed.toString().replace(/\/$/, "");
  return withConfigWriteLock(CONFIG_PATH, () => {
    const existing = readInstafyCliConfig();
    let existingOrigin: string | null = null;
    try {
      existingOrigin = existing.controllerUrl ? new URL(existing.controllerUrl).origin : null;
    } catch {
      existingOrigin = null;
    }
    const originChanged =
      Boolean(existing.accessToken || existing.refreshToken) && existingOrigin !== parsed.origin;
    const next = mergeConfig(existing, {
      controllerUrl: normalizedControllerUrl,
      ...(originChanged
        ? {
            accessToken: null,
            refreshToken: null,
            supabaseUrl: null,
            supabaseAnonKey: null,
          }
        : {}),
    });
    writeConfigAtomically(CONFIG_PATH, next);
    return next;
  });
}

export function writeInstafyProfileConfig(
  profile: string,
  update: Partial<InstafyCliConfig>,
): InstafyCliConfig {
  const filePath = getInstafyProfileConfigPath(profile);
  return withConfigWriteLock(filePath, () => {
    const next = mergeConfig(readInstafyProfileConfig(profile), update);
    writeConfigAtomically(filePath, next);
    return next;
  });
}

export type StoredAuthSessionSnapshot = Pick<
  InstafyCliConfig,
  "controllerUrl" | "accessToken" | "refreshToken" | "supabaseUrl" | "supabaseAnonKey"
>;

function authSessionMatches(
  config: InstafyCliConfig,
  expected: StoredAuthSessionSnapshot,
): boolean {
  return (
    normalizeUrl(config.controllerUrl ?? null) === normalizeUrl(expected.controllerUrl ?? null) &&
    normalizeToken(config.accessToken ?? null) === normalizeToken(expected.accessToken ?? null) &&
    normalizeToken(config.refreshToken ?? null) === normalizeToken(expected.refreshToken ?? null) &&
    normalizeUrl(config.supabaseUrl ?? null) === normalizeUrl(expected.supabaseUrl ?? null) &&
    normalizeToken(config.supabaseAnonKey ?? null) === normalizeToken(expected.supabaseAnonKey ?? null)
  );
}

export function replaceStoredAuthSessionIfUnchanged(params: {
  profile?: string | null;
  expected: StoredAuthSessionSnapshot;
  update: StoredAuthSessionSnapshot;
}): InstafyCliConfig | null {
  const profile = normalizeProfileName(params.profile ?? null);
  const filePath = profile ? getInstafyProfileConfigPath(profile) : CONFIG_PATH;
  return withConfigWriteLock(filePath, () => {
    const existing = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();
    if (!authSessionMatches(existing, params.expected)) return null;
    const next = mergeConfig(existing, params.update);
    writeConfigAtomically(filePath, next);
    return next;
  });
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

  const update: Partial<InstafyCliConfig> = {};
  for (const key of keys) {
    update[key] = null;
  }
  writeInstafyCliConfig(update);
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

  const update: Partial<InstafyCliConfig> = {};
  for (const key of keys) {
    update[key] = null;
  }
  writeInstafyProfileConfig(profile, update);
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
