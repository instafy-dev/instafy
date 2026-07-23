import { test as base } from "@playwright/test";
import fs from "node:fs";

import {
  closeElectronApplication,
  createElectronBrowserProvisioningRegistration,
  type ElectronBrowserProvisioningRegistration,
  type ElectronStudioLaunch,
  type ProvisionedElectronBrowserStudio,
} from "./electronBrowserLiveHarness.js";
import {
  cleanupElectronBrowserStudio,
  ElectronBrowserCleanupError,
  type ElectronBrowserCleanupConfig,
} from "./electronBrowserLiveCleanup.js";
import {
  recoverElectronBrowserLocalProfile,
  recoverElectronBrowserStudioFromJournalOrTarget,
  resolveElectronBrowserRecoveryDirectory,
} from "./electronBrowserLiveRecovery.js";
import {
  acquireElectronBrowserLiveRunLock,
  type ElectronBrowserLiveRunLock,
} from "./electronBrowserLiveRunLock.js";

const CLEANUP_TIMEOUT_MS = 600_000;
const ELECTRON_CLOSE_TIMEOUT_MS = 15_000;

export type ElectronBrowserLiveCleanupState = {
  config: ElectronBrowserCleanupConfig | null;
  provisioning: ElectronBrowserProvisioningRegistration;
  provisioned: ProvisionedElectronBrowserStudio | null;
  launched: ElectronStudioLaunch | null;
  credentialId: string | null;
  recoveryMarker: string | null;
  recoveryJournalPath: string | null;
};

export const electronBrowserLiveTest = base.extend<{
  electronBrowserLiveRunLock: ElectronBrowserLiveRunLock;
  electronBrowserLiveCleanup: ElectronBrowserLiveCleanupState;
}>({
  electronBrowserLiveRunLock: [
    async ({ request }, use) => {
      // Playwright requires fixture dependencies to use object destructuring.
      // Referencing request also keeps this declaration lint-clean without
      // broadening the process lock's responsibilities.
      void request;
      const lock = acquireElectronBrowserLiveRunLock(
        resolveElectronBrowserRecoveryDirectory(),
      );
      try {
        await use(lock);
      } finally {
        lock.release();
      }
    },
    { scope: "test", timeout: 30_000 },
  ],
  electronBrowserLiveCleanup: [
    async ({ request, electronBrowserLiveRunLock }, use) => {
      // Keep the exclusive lock held until strict local and server cleanup has
      // completed. Shared and Personal canaries use the same disposable
      // identity journal, so they must never recover one another concurrently.
      void electronBrowserLiveRunLock;
      const state: ElectronBrowserLiveCleanupState = {
        config: null,
        provisioning: createElectronBrowserProvisioningRegistration(),
        provisioned: null,
        launched: null,
        credentialId: null,
        recoveryMarker: null,
        recoveryJournalPath: null,
      };
      await use(state);

      if (!state.config) {
        return;
      }
      const cleanupTarget = state.provisioned ?? state.provisioning;
      if (
        !cleanupTarget.userId &&
        !cleanupTarget.orgId &&
        !cleanupTarget.projectId &&
        !state.recoveryJournalPath
      ) {
        return;
      }

      const cleanupFailures: Error[] = [];
      let localProfileRecoveryFailed = false;
      if (state.launched) {
        try {
          await closeElectronApplication(
            state.launched.app,
            ELECTRON_CLOSE_TIMEOUT_MS,
          );
        } catch (error) {
          cleanupFailures.push(
            new Error(
              `Electron close failed (${error instanceof Error ? error.name : "unknown error"}).`,
            ),
          );
        }
      }

      try {
        if (state.recoveryMarker) {
          await recoverElectronBrowserLocalProfile(state.recoveryMarker);
        } else if (state.launched) {
          fs.rmSync(state.launched.userDataDir, {
            recursive: true,
            force: true,
          });
        }
        if (state.launched && fs.existsSync(state.launched.userDataDir)) {
          throw new Error("Electron profile directory remains");
        }
      } catch (error) {
        localProfileRecoveryFailed = true;
        cleanupFailures.push(
          new Error(
            `Electron profile cleanup failed (${error instanceof Error ? error.name : "unknown error"}).`,
          ),
        );
      }

      if (localProfileRecoveryFailed) {
        // The journal is the only durable link between a possible live local
        // session and its disposable server identity. Never remove it while
        // process/profile cleanup is unverified.
        throw new Error(
          [
            "Electron Browser live smoke cleanup failed.",
            ...cleanupFailures.map((failure) => failure.message),
          ].join("\n"),
        );
      }

      if (state.recoveryJournalPath) {
        try {
          // Reconcile before deleting the user. The ownership evidence is
          // needed when a create committed but its response was lost.
          await recoverElectronBrowserStudioFromJournalOrTarget(
            request,
            state.config,
            state.recoveryJournalPath,
            cleanupTarget,
            state.credentialId,
          );
        } catch (error) {
          cleanupFailures.push(
            error instanceof ElectronBrowserCleanupError
              ? error
              : new Error(
                  `Recovery journal cleanup failed (${error instanceof Error ? error.name : "unknown error"}).`,
                ),
          );
        }
      } else {
        try {
          await cleanupElectronBrowserStudio(
            request,
            state.config,
            cleanupTarget,
            state.credentialId,
          );
        } catch (error) {
          cleanupFailures.push(
            error instanceof ElectronBrowserCleanupError
              ? error
              : new Error(
                  `Server cleanup failed (${error instanceof Error ? error.name : "unknown error"}).`,
                ),
          );
        }
      }

      if (cleanupFailures.length > 0) {
        throw new Error(
          [
            "Electron Browser live smoke cleanup failed.",
            ...cleanupFailures.map((failure) => failure.message),
          ].join("\n"),
        );
      }
    },
    // Fixture teardown receives its own budget after a timed-out test body.
    { scope: "test", timeout: CLEANUP_TIMEOUT_MS },
  ],
});
