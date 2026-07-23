import { expect, test, type Page } from "@playwright/test";
import {
  markRuntimeOffline,
  prepareStudio,
  registerLocalWorkspace,
  registerRuntimeViaAgent,
  resetRuntimeUserState,
} from "../utils/harness.js";
import { dismissToastIfVisible } from "../utils/toasts.js";

const DESKTOP_OFFLINE_MESSAGE =
  "Desktop runtime went offline. Falling back to Instafy Cloud.";

async function watchForToastMessage(
  page: Page,
  message: string,
  timeoutMs: number,
): Promise<boolean> {
  return await page.evaluate(
    ({ targetMessage, timeoutMs: timeout }) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        let timer = 0;
        let observer: MutationObserver | null = null;

        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) window.clearTimeout(timer);
          observer?.disconnect();
          resolve(value);
        };

        const includesTargetMessage = () => {
          const toast = document.querySelector('[data-testid="status-toast"]');
          const content = toast?.textContent ?? "";
          return content.includes(targetMessage);
        };

        if (includesTargetMessage()) {
          finish(true);
          return;
        }

        observer = new MutationObserver(() => {
          if (includesTargetMessage()) {
            finish(true);
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });

        timer = window.setTimeout(() => finish(false), timeout);
      }),
    { targetMessage: message, timeoutMs },
  );
}

test.describe.serial("Runtime status toasts", () => {
  test.setTimeout(120_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "runtime-status-toasts:cleanup" }).catch(
      () => {},
    );
  });

  test("does not show desktop offline fallback toast for an unselected local runtime", async ({
    page,
  }) => {
    await prepareStudio(page);

    // Mirror production where desktop workspace presence can exist even when the
    // user is actively using Hosted Runtime.
    const deviceId = `playwright-unselected-local-${Date.now()}`;
    await registerLocalWorkspace(page, {
      path: "/tmp/playwright-runtime-toast-regression",
      deviceId,
    });

    const runtimeId = await registerRuntimeViaAgent(page, {
      displayName: `Playwright Local Runtime ${Date.now()}`,
    });
    if (!runtimeId) {
      test.skip(true, "Unable to register local runtime via agent.");
      return;
    }

    await page.evaluate(async () => {
      await (window as any)?.__INSTAFY_RUNTIME__?.refreshRuntimeStatuses?.();
    });
    await expect
      .poll(
        async () =>
          await page.evaluate((targetRuntimeId) => {
            const runtimeApi = (window as any)?.__INSTAFY_RUNTIME__;
            const snapshot = runtimeApi?.getSnapshot?.();
            const statuses = Array.isArray(snapshot?.runtimeStatuses)
              ? snapshot.runtimeStatuses
              : [];
            const match = statuses.find(
              (entry: any) => entry?.runtimeId === targetRuntimeId,
            );
            return match?.isLocal === true;
          }, runtimeId),
        { timeout: 20_000 },
      )
      .toBe(true);

    const runtimeSelector = page.getByTestId("runtime-selector-button").first();
    await expect(runtimeSelector).toContainText(/Cloud runtime|Hosted Runtime/i);
    await dismissToastIfVisible(page);

    const sawDesktopOfflineToast = watchForToastMessage(
      page,
      DESKTOP_OFFLINE_MESSAGE,
      7_000,
    );
    await markRuntimeOffline(page, runtimeId);
    await page.evaluate(async () => {
      await (window as any)?.__INSTAFY_RUNTIME__?.refreshRuntimeStatuses?.();
    });

    await expect(sawDesktopOfflineToast).resolves.toBe(false);
  });
});
