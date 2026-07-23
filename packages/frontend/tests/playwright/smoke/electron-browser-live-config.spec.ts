import { expect, test } from "@playwright/test";

import type { ElectronBrowserCleanupConfig } from "../utils/electronBrowserLiveCleanup.js";
import { resolveElectronBrowserStudioConfig } from "../utils/electronBrowserLiveHarness.js";

const CONFIG_ENV_KEYS = [
  "HOME",
  "PLAYWRIGHT_BASE_URL",
  "PLAYWRIGHT_ELECTRON_SHARED_BROWSER_BASE_URL",
  "PLAYWRIGHT_EXTERNAL_BASE_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
] as const;

async function withConfigEnv(
  env: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string | undefined>>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof CONFIG_ENV_KEYS)[number], string | undefined>;
  try {
    for (const key of CONFIG_ENV_KEYS) {
      const value = env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await run();
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const cleanupConfig: ElectronBrowserCleanupConfig = {
  controllerUrl: "https://controller.example.test///",
  supabaseServiceRoleKey: " service-role-marker ",
  supabaseUrl: "https://supabase.example.test///",
};

test.describe("Electron Shared Browser Studio configuration", () => {
  test("resolves provisioning and launch configuration without machine auth", async () => {
    await withConfigEnv(
      {
        HOME: "/path/without/codex-auth",
        PLAYWRIGHT_ELECTRON_SHARED_BROWSER_BASE_URL:
          "https://app.example.test///",
        VITE_SUPABASE_ANON_KEY: " anon-marker ",
      },
      () => {
        expect(resolveElectronBrowserStudioConfig(cleanupConfig)).toEqual({
          appBaseUrl: "https://app.example.test",
          controllerUrl: "https://controller.example.test",
          supabaseAnonKey: "anon-marker",
          supabaseServiceRoleKey: "service-role-marker",
          supabaseUrl: "https://supabase.example.test",
        });
      },
    );
  });

  test("validates cleanup URLs and credentials", async () => {
    await withConfigEnv({ VITE_SUPABASE_ANON_KEY: "anon-marker" }, () => {
      expect(() =>
        resolveElectronBrowserStudioConfig({
          ...cleanupConfig,
          controllerUrl: "file:///tmp/controller",
        }),
      ).toThrow(/controller URL must be an http\(s\) URL/i);
      expect(() =>
        resolveElectronBrowserStudioConfig({
          ...cleanupConfig,
          supabaseServiceRoleKey: "   ",
        }),
      ).toThrow(/service role key is required/i);
      expect(() =>
        resolveElectronBrowserStudioConfig({
          ...cleanupConfig,
          supabaseUrl: "not a URL",
        }),
      ).toThrow();
    });
  });
});
