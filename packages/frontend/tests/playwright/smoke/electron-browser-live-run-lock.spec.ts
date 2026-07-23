import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireElectronBrowserLiveRunLock,
  ElectronBrowserLiveRunLockError,
} from "../utils/electronBrowserLiveRunLock.js";

function temporaryRecoveryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-run-lock-"));
}

test.describe("Electron Shared Browser production-smoke run lock", () => {
  test("allows only one live owner and becomes reusable after release", () => {
    const directory = temporaryRecoveryDirectory();
    try {
      const first = acquireElectronBrowserLiveRunLock(directory);
      expect(() => acquireElectronBrowserLiveRunLock(directory)).toThrow(
        /already held by a live process/,
      );
      first.release();

      const second = acquireElectronBrowserLiveRunLock(directory);
      second.release();
      expect(fs.existsSync(path.join(directory, ".run.lock"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically reclaims a well-formed lock whose owner is dead", () => {
    const directory = temporaryRecoveryDirectory();
    try {
      acquireElectronBrowserLiveRunLock(directory);
      const ownerPath = path.join(directory, ".run.lock", "owner.json");
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Record<
        string,
        unknown
      >;
      owner.pid = 2_147_483_647;
      fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

      const recovered = acquireElectronBrowserLiveRunLock(directory);
      recovered.release();
      expect(fs.existsSync(path.join(directory, ".run.lock"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed instead of deleting an unreadable lock", () => {
    const directory = temporaryRecoveryDirectory();
    try {
      const lockPath = path.join(directory, ".run.lock");
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "owner.json"), "not-json\n", {
        mode: 0o600,
      });

      expect(() => acquireElectronBrowserLiveRunLock(directory)).toThrow(
        ElectronBrowserLiveRunLockError,
      );
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses private directory and owner-file permissions", () => {
    const directory = temporaryRecoveryDirectory();
    try {
      const lock = acquireElectronBrowserLiveRunLock(directory);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(lock.lockPath, "owner.json")).mode & 0o777).toBe(
        0o600,
      );
      lock.release();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
