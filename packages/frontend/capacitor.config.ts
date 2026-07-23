import type { CapacitorConfig } from "@capacitor/cli";
import { readFileSync } from "node:fs";
import path from "node:path";

function normalizePem(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\n/g, "\n");
}

function normalizePath(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function resolveIncludedPlugins(): string[] | undefined {
  const requested = (process.env.INSTAFY_CAPACITOR_EXTRA_PLUGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return undefined;
  }

  const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
  for (const packageName of requested) {
    if (!packageNamePattern.test(packageName)) {
      throw new Error(`Invalid package name in INSTAFY_CAPACITOR_EXTRA_PLUGINS: ${packageName}`);
    }
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(__dirname, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [
    ...new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...requested,
    ]),
  ];
}

const includedPlugins = resolveIncludedPlugins();
const androidPath = normalizePath(process.env.INSTAFY_CAPACITOR_ANDROID_PATH);
const iosPath = normalizePath(process.env.INSTAFY_CAPACITOR_IOS_PATH);

const config: CapacitorConfig = {
  appId: "dev.instafy.studio",
  appName: "Instafy",
  webDir: "dist",
  bundledWebRuntime: false,
  android:
    androidPath || includedPlugins
      ? {
          ...(androidPath ? { path: androidPath } : {}),
          ...(includedPlugins ? { includePlugins: includedPlugins } : {}),
        }
      : undefined,
  ios:
    iosPath || includedPlugins
      ? {
          ...(iosPath ? { path: iosPath } : {}),
          ...(includedPlugins ? { includePlugins: includedPlugins } : {}),
        }
      : undefined,
  plugins: {
    StatusBar: {
      backgroundColor: "#ffffff",
      overlaysWebView: false,
      style: "LIGHT",
    },
    LiveUpdate: {
      autoBlockRolledBackBundles: true,
      autoDeleteBundles: true,
      autoUpdateStrategy: "none",
      defaultChannel:
        process.env.CAPACITOR_LIVE_UPDATE_DEFAULT_CHANNEL?.trim() ||
        process.env.VITE_OTA_CHANNEL?.trim() ||
        "stable",
      publicKey: normalizePem(process.env.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY),
      readyTimeout: 10000,
    },
  },
};

export default config;
