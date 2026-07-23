import kleur from "kleur";
import {
  clearInstafyCliConfig,
  getInstafyConfigPath,
  readInstafyCliConfig,
  writeInstafyCliConfig,
  type InstafyCliConfig,
} from "./config.js";

type SupportedKey = "controller-url" | "studio-url";

function normalizeKey(raw: string): SupportedKey {
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  if (key === "controller-url" || key === "controllerurl" || key === "server-url") {
    return "controller-url";
  }
  if (key === "studio-url" || key === "studiourl") {
    return "studio-url";
  }
  throw new Error(`Unknown config key: ${raw} (supported: controller-url, studio-url)`);
}

function getValue(config: InstafyCliConfig, key: SupportedKey): string | null {
  if (key === "controller-url") return config.controllerUrl ?? null;
  if (key === "studio-url") return config.studioUrl ?? null;
  return null;
}

function updateConfig(key: SupportedKey, value: string): InstafyCliConfig {
  if (key === "controller-url") {
    return writeInstafyCliConfig({ controllerUrl: value });
  }
  if (key === "studio-url") {
    return writeInstafyCliConfig({ studioUrl: value });
  }
  return writeInstafyCliConfig({});
}

function clearConfig(key: SupportedKey): void {
  if (key === "controller-url") {
    clearInstafyCliConfig(["controllerUrl"]);
    return;
  }
  if (key === "studio-url") {
    clearInstafyCliConfig(["studioUrl"]);
    return;
  }
}

export function configPath(options?: { json?: boolean }): void {
  const path = getInstafyConfigPath();
  if (options?.json) {
    console.log(JSON.stringify({ path }, null, 2));
    return;
  }
  console.log(path);
}

export function configList(options?: { json?: boolean }): void {
  const config = readInstafyCliConfig();
  const payload = {
    path: getInstafyConfigPath(),
    controllerUrl: config.controllerUrl ?? null,
    studioUrl: config.studioUrl ?? null,
    accessTokenSet: Boolean(config.accessToken),
    refreshTokenSet: Boolean(config.refreshToken),
    updatedAt: config.updatedAt ?? null,
  };

  if (options?.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(kleur.green("Instafy CLI config"));
  console.log(`Path: ${payload.path}`);
  console.log(`controller-url: ${payload.controllerUrl ?? kleur.yellow("(not set)")}`);
  console.log(`studio-url: ${payload.studioUrl ?? kleur.yellow("(not set)")}`);
  console.log(`access-token: ${payload.accessTokenSet ? kleur.green("(set)") : kleur.yellow("(not set)")}`);
  console.log(`refresh-token: ${payload.refreshTokenSet ? kleur.green("(set)") : kleur.yellow("(not set)")}`);
  if (payload.updatedAt) {
    console.log(`updated-at: ${payload.updatedAt}`);
  }
}

export function configGet(params: { key: string; json?: boolean }): void {
  const key = normalizeKey(params.key);
  const config = readInstafyCliConfig();
  const value = getValue(config, key);
  if (!value) {
    throw new Error(`Config key ${key} is not set. Run \`instafy config set ${key} <value>\`.`);
  }
  if (params.json) {
    console.log(JSON.stringify({ key, value }, null, 2));
    return;
  }
  console.log(value);
}

export function configSet(params: { key: string; value: string; json?: boolean }): void {
  const key = normalizeKey(params.key);
  const updated = updateConfig(key, params.value);
  const value = getValue(updated, key);
  if (!value) {
    throw new Error(`Failed to set ${key}.`);
  }
  if (params.json) {
    console.log(JSON.stringify({ key, value, path: getInstafyConfigPath() }, null, 2));
    return;
  }
  console.log(kleur.green(`Set ${key}`));
  console.log(value);
}

export function configUnset(params: { key: string; json?: boolean }): void {
  const key = normalizeKey(params.key);
  clearConfig(key);
  if (params.json) {
    console.log(JSON.stringify({ ok: true, key }, null, 2));
    return;
  }
  console.log(kleur.green(`Unset ${key}`));
}
