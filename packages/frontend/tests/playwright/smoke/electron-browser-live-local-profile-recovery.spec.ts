import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  launchElectronStudio,
  type ElectronBrowserLiveConfig,
} from "../utils/electronBrowserLiveHarness.js";
import {
  checkpointElectronBrowserRecoveryProfileProcess,
  ElectronBrowserRecoveryJournalError,
  prepareElectronBrowserRecoveryProfile,
  recoverElectronBrowserLocalProfile,
  recoverElectronBrowserStudiosBeforeProvisioning,
  resolveElectronBrowserRecoveryProfilePath,
} from "../utils/electronBrowserLiveRecovery.js";

const OWNER_FILE = ".instafy-smoke-profile-owner.json";

function temporaryRecoveryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "instafy-profile-recovery-"));
}

test.describe("Electron Shared Browser local profile recovery", () => {
  test("still rejects a live marker-owned process when its profile directory is missing", async () => {
    const marker = randomUUID();
    const markerPid = 777_776;
    const recoveryDirectory = temporaryRecoveryDirectory();
    try {
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          commandForPid: (pid) =>
            pid === markerPid
              ? `Electron --instafy-smoke-recovery-marker=${marker}`
              : null,
          findProfilePids: () => [markerPid],
          isProcessAlive: (pid) => pid === markerPid,
          recoveryDirectory,
        }),
      ).rejects.toThrow(/process remains after its profile disappeared/i);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("accepts a missing profile only after marker-process discovery is empty", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    try {
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          findProfilePids: () => [],
          isProcessAlive: () => false,
          recoveryDirectory,
        }),
      ).resolves.toBe(false);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("uses a private deterministic profile and removes it after a dead process", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = prepareElectronBrowserRecoveryProfile(
      marker,
      recoveryDirectory,
    );
    try {
      expect(profilePath).toBe(
        resolveElectronBrowserRecoveryProfilePath(marker, recoveryDirectory),
      );
      expect(fs.statSync(profilePath).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(profilePath, OWNER_FILE)).mode & 0o777).toBe(
        0o600,
      );

      checkpointElectronBrowserRecoveryProfileProcess(
        marker,
        2_147_483_647,
        recoveryDirectory,
      );
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          isProcessAlive: () => false,
          recoveryDirectory,
        }),
      ).resolves.toBe(true);
      expect(fs.existsSync(profilePath)).toBe(false);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("fails closed when the profile owner marker was changed", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = prepareElectronBrowserRecoveryProfile(
      marker,
      recoveryDirectory,
    );
    try {
      const ownerPath = path.join(profilePath, OWNER_FILE);
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Record<
        string,
        unknown
      >;
      owner.recoveryMarker = randomUUID();
      fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          isProcessAlive: () => false,
          recoveryDirectory,
        }),
      ).rejects.toThrow(ElectronBrowserRecoveryJournalError);
      expect(fs.existsSync(profilePath)).toBe(true);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("waits for a verified orphan Electron process before removing its profile", async () => {
    const marker = randomUUID();
    const electronPid = 777_777;
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = prepareElectronBrowserRecoveryProfile(
      marker,
      recoveryDirectory,
    );
    try {
      checkpointElectronBrowserRecoveryProfileProcess(
        marker,
        electronPid,
        recoveryDirectory,
      );
      let alive = true;
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          commandForPid: () =>
            `Electron --instafy-smoke-recovery-marker=${marker}`,
          isProcessAlive: (pid) => pid === electronPid && alive,
          recoveryDirectory,
          wait: async () => {
            alive = false;
          },
        }),
      ).resolves.toBe(true);
      expect(fs.existsSync(profilePath)).toBe(false);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("waits for marker-owned helper processes after the Electron main pid exits", async () => {
    const marker = randomUUID();
    const electronPid = 777_778;
    const helperPid = 777_779;
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = prepareElectronBrowserRecoveryProfile(
      marker,
      recoveryDirectory,
    );
    try {
      checkpointElectronBrowserRecoveryProfileProcess(
        marker,
        electronPid,
        recoveryDirectory,
      );
      let helperAlive = true;
      let waited = false;
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          commandForPid: (pid) =>
            pid === helperPid
              ? `Electron Helper --user-data-dir=${profilePath}`
              : null,
          findProfilePids: () => (helperAlive ? [helperPid] : []),
          isProcessAlive: (pid) => pid === helperPid && helperAlive,
          recoveryDirectory,
          wait: async () => {
            waited = true;
            helperAlive = false;
          },
        }),
      ).resolves.toBe(true);
      expect(waited).toBe(true);
      expect(fs.existsSync(profilePath)).toBe(false);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("fails closed when marker process discovery is unavailable after main exit", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = prepareElectronBrowserRecoveryProfile(
      marker,
      recoveryDirectory,
    );
    try {
      checkpointElectronBrowserRecoveryProfileProcess(
        marker,
        777_780,
        recoveryDirectory,
      );
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          findProfilePids: () => null,
          isProcessAlive: () => false,
          recoveryDirectory,
        }),
      ).rejects.toThrow(/process discovery was unavailable/i);
      expect(fs.existsSync(profilePath)).toBe(true);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("never removes a profile for an unverified live pid", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = prepareElectronBrowserRecoveryProfile(
      marker,
      recoveryDirectory,
    );
    try {
      checkpointElectronBrowserRecoveryProfileProcess(
        marker,
        123_456,
        recoveryDirectory,
      );
      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          commandForPid: () => "unrelated-process",
          isProcessAlive: () => true,
          recoveryDirectory,
        }),
      ).rejects.toThrow(/process identity could not be verified/i);
      expect(fs.existsSync(profilePath)).toBe(true);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("wires the marker, parent watchdog, owner pid, and deterministic profile into launch", async () => {
    const marker = randomUUID();
    const electronPid = 456_789;
    const recoveryDirectory = temporaryRecoveryDirectory();
    let launchOptions: {
      args?: string[];
      env?: NodeJS.ProcessEnv;
    } | null = null;
    const fakeApp = {
      close: async () => undefined,
      firstWindow: async () => ({}),
      process: () => ({
        exitCode: null,
        kill: () => true,
        pid: electronPid,
        signalCode: null,
      }),
    };
    const config: ElectronBrowserLiveConfig = {
      appBaseUrl: "https://app.example.test",
      controllerUrl: "https://controller.example.test",
      defaultCodexAuthJsonPath: "~/.codex/auth.json",
      supabaseAnonKey: "anon-test",
      supabaseServiceRoleKey: "service-test",
      supabaseUrl: "https://supabase.example.test",
    };
    const profilePath = resolveElectronBrowserRecoveryProfilePath(
      marker,
      recoveryDirectory,
    );

    try {
      const launched = await launchElectronStudio(
        config,
        "11111111-1111-4111-8111-111111111111",
        {
          desktopAppBuildExists: () => true,
          recoveryDirectory,
          recoveryMarker: marker,
          launch: (async (options: {
            args?: string[];
            env?: NodeJS.ProcessEnv;
          }) => {
            launchOptions = options;
            return fakeApp;
          }) as never,
        },
      );

      expect(launched.userDataDir).toBe(profilePath);
      expect(launchOptions?.args).toContain(
        `--instafy-smoke-recovery-marker=${marker}`,
      );
      expect(launchOptions?.env).toMatchObject({
        INSTAFY_DESKTOP_SMOKE_PARENT_PID: String(process.pid),
        INSTAFY_DESKTOP_SMOKE_RECOVERY_ROOT: recoveryDirectory,
        INSTAFY_DESKTOP_SMOKE_RECOVERY_MARKER: marker,
        INSTAFY_DESKTOP_USER_DATA_DIR: profilePath,
      });
      const owner = JSON.parse(
        fs.readFileSync(path.join(profilePath, OWNER_FILE), "utf8"),
      ) as Record<string, unknown>;
      expect(owner).toMatchObject({
        electronPid,
        parentPid: process.pid,
        recoveryMarker: marker,
      });
    } finally {
      await recoverElectronBrowserLocalProfile(marker, {
        isProcessAlive: () => false,
        recoveryDirectory,
      }).catch(() => false);
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("recovers a prior process profile even when the next process has a different TMPDIR", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    const profilePath = resolveElectronBrowserRecoveryProfilePath(
      marker,
      recoveryDirectory,
    );
    const childTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "instafy-profile-child-tmp-"),
    );
    try {
      const script = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const [profilePath, marker] = process.argv.slice(1);",
        "fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });",
        "const owner = { version: 1, recoveryMarker: marker, parentPid: 2147483647, electronPid: null, createdAt: new Date().toISOString() };",
        `fs.writeFileSync(path.join(profilePath, ${JSON.stringify(OWNER_FILE)}), JSON.stringify(owner) + '\\n', { mode: 0o600 });`,
      ].join("\n");
      const child = spawnSync(process.execPath, ["-e", script, profilePath, marker], {
        env: { ...process.env, TMPDIR: childTmp },
        encoding: "utf8",
      });
      expect(child.status).toBe(0);
      expect(fs.existsSync(profilePath)).toBe(true);

      await expect(
        recoverElectronBrowserLocalProfile(marker, {
          findProfilePids: () => [],
          isProcessAlive: () => false,
          recoveryDirectory,
        }),
      ).resolves.toBe(true);
      expect(fs.existsSync(profilePath)).toBe(false);
    } finally {
      fs.rmSync(childTmp, { recursive: true, force: true });
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("blocks provisioning when a local profile has no matching journal", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    prepareElectronBrowserRecoveryProfile(marker, recoveryDirectory);
    try {
      await expect(
        recoverElectronBrowserStudiosBeforeProvisioning(
          {} as never,
          {
            controllerUrl: "https://controller.example.test",
            supabaseServiceRoleKey: "service-test",
            supabaseUrl: "https://supabase.example.test",
          },
          recoveryDirectory,
        ),
      ).rejects.toThrow(/no matching recovery journal/i);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });

  test("preserves a marker-owned profile when launch cleanup cannot verify a live process", async () => {
    const marker = randomUUID();
    const recoveryDirectory = temporaryRecoveryDirectory();
    const config: ElectronBrowserLiveConfig = {
      appBaseUrl: "https://app.example.test",
      controllerUrl: "https://controller.example.test",
      defaultCodexAuthJsonPath: "~/.codex/auth.json",
      supabaseAnonKey: "anon-test",
      supabaseServiceRoleKey: "service-test",
      supabaseUrl: "https://supabase.example.test",
    };
    const fakeApp = {
      close: async () => {
        throw new Error("close failed");
      },
      firstWindow: async () => {
        throw new Error("window failed");
      },
      process: () => ({
        exitCode: null,
        kill: () => false,
        pid: process.pid,
        signalCode: null,
      }),
    };
    const profilePath = resolveElectronBrowserRecoveryProfilePath(
      marker,
      recoveryDirectory,
    );
    try {
      const error = await launchElectronStudio(
        config,
        "11111111-1111-4111-8111-111111111111",
        {
          closeTimeoutMs: 5,
          desktopAppBuildExists: () => true,
          recoveryDirectory,
          recoveryMarker: marker,
          launch: (async () => fakeApp) as never,
        },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(fs.existsSync(profilePath)).toBe(true);
      expect(fs.existsSync(path.join(profilePath, OWNER_FILE))).toBe(true);
    } finally {
      fs.rmSync(recoveryDirectory, { recursive: true, force: true });
    }
  });
});
