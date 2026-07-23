import { test } from "@playwright/test";

import { resolveElectronBrowserLiveCleanupConfig } from "../utils/electronBrowserLiveHarness.js";
import {
  recoverElectronBrowserStudiosBeforeProvisioning,
  resolveElectronBrowserRecoveryDirectory,
} from "../utils/electronBrowserLiveRecovery.js";
import { acquireElectronBrowserLiveRunLock } from "../utils/electronBrowserLiveRunLock.js";

const ENABLED =
  (process.env.PLAYWRIGHT_ELECTRON_SHARED_BROWSER_RECOVERY ?? "").trim() === "1";

test.use({ trace: "off", video: "off", screenshot: "off" });

test.describe("Electron Shared Browser production recovery", () => {
  test.describe.configure({ retries: 0 });
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_ELECTRON_SHARED_BROWSER_RECOVERY=1 for retained canary cleanup.",
  );
  test.setTimeout(600_000);

  test("strictly recovers every marked disposable Studio before another canary", async ({
    request,
  }) => {
    const recoveryDirectory = resolveElectronBrowserRecoveryDirectory();
    const lock = acquireElectronBrowserLiveRunLock(recoveryDirectory);
    try {
      await recoverElectronBrowserStudiosBeforeProvisioning(
        request,
        resolveElectronBrowserLiveCleanupConfig(),
        recoveryDirectory,
      );
    } finally {
      lock.release();
    }
  });
});
