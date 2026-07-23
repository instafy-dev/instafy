import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredToken {
  token: string;
  expiresAt: string;
}

export type StoredOriginToken = StoredToken;
export type StoredControllerToken = StoredToken;

export interface ProfileConfig {
  projectId?: string;
  controllerUrl?: string;
  controllerJwksUrl?: string;
  workspaceDir?: string;
  runtimeBinaryPath?: string;
  displayName?: string;
  agentKey?: string;
  controllerAccessToken?: string;
  supabaseAccessToken?: string;
  ratholeBin?: string;
  ratholeCacheDir?: string;
  ratholeStateDir?: string;
  ratholeVersion?: string;
  originToken?: StoredOriginToken;
  controllerSession?: StoredControllerToken;
}

export interface CliConfig {
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
}

const CONFIG_DIR = path.join(os.homedir(), ".instafy");
const CONFIG_FILE = path.join(CONFIG_DIR, "desktop-cli.json");

const DEFAULT_CONFIG: CliConfig = {
  activeProfile: "default",
  profiles: {},
};

export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    if (!parsed.activeProfile) {
      parsed.activeProfile = DEFAULT_CONFIG.activeProfile;
    }
    if (!parsed.profiles) {
      parsed.profiles = {};
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw error;
  }
}

export function saveConfig(config: CliConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

export function resolveProfile(
  config: CliConfig,
  name?: string | null,
): { profile: ProfileConfig; name: string } {
  const profileName = (name && name.trim().length > 0
    ? name.trim()
    : config.activeProfile) || DEFAULT_CONFIG.activeProfile;
  if (!config.profiles[profileName]) {
    config.profiles[profileName] = {};
  }
  return { profile: config.profiles[profileName], name: profileName };
}

export function setActiveProfile(config: CliConfig, name: string) {
  config.activeProfile = name.trim() || DEFAULT_CONFIG.activeProfile;
}

export function clearStoredOriginToken(profile: ProfileConfig) {
  delete profile.originToken;
}

export function clearStoredControllerSession(profile: ProfileConfig) {
  delete profile.controllerSession;
}

export function isStoredTokenValid(
  stored: StoredToken | undefined,
  skewSeconds = 30,
): stored is StoredToken {
  if (!stored) {
    return false;
  }
  const expiresAt = Date.parse(stored.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return false;
  }
  const now = Date.now();
  return now + skewSeconds * 1000 < expiresAt;
}
