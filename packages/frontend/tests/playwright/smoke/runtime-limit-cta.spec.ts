import { expect, test, type Page } from "@playwright/test";
import { clearRuntimePreference, prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

const LIMIT_MESSAGE =
  "Instafy Cloud runtime limit reached for this organization (2 active; max 2). Active runtime \"Hosted Runtime\" is attached to project \"Other Project\" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.";
const LIMIT_DETAILS = {
  activeCount: 2,
  maxActiveCount: 2,
  blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  blockerProjectLabel: "Other Project",
  blockerRuntimeLabel: "Hosted Runtime",
};

type RuntimeE2EBridge = {
  ensureHostedRuntime?: () => Promise<boolean>;
};

async function openRuntimeSelector(page: Page) {
  const runtimeAiTrigger = page.getByRole("button", { name: /Runtime & AI:/i }).first();
  const fallbackTrigger = page.locator('[data-testid="runtime-selector-button"]:visible').first();
  const useRuntimeAiTrigger = await runtimeAiTrigger.isVisible().catch(() => false);
  const trigger = useRuntimeAiTrigger ? runtimeAiTrigger : fallbackTrigger;
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click();
  const popover = page.getByTestId("runtime-selector-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  const runtimeOptionsToggle = popover
    .getByRole("button", { name: /Show runtime options|Hide runtime options/i })
    .first();
  if (await runtimeOptionsToggle.isVisible().catch(() => false)) {
    const toggleLabel = ((await runtimeOptionsToggle.textContent().catch(() => "")) ?? "")
      .toLowerCase()
      .trim();
    if (toggleLabel.includes("show runtime options")) {
      await runtimeOptionsToggle.click();
      await expect(
        popover.getByRole("button", { name: /Hide runtime options/i }).first(),
      ).toBeVisible({ timeout: 5_000 });
    }
  }
}

test.describe.serial("Runtime limit CTA", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "runtime-limit-cta:cleanup" }).catch(
      () => {},
    );
  });

  test("runtime limit error shows actionable retry guidance", async ({ page }) => {
    let ensureAttempts = 0;

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      ensureAttempts += 1;
      if (ensureAttempts > 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({
          message: LIMIT_MESSAGE,
          code: "runtime_limit_reached",
          details: LIMIT_DETAILS,
        }),
      });
    });

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    await clearRuntimePreference(page, { projectId, source: "runtime-limit-cta" }).catch(
      () => {},
    );
    await resetRuntimeUserState(page, { source: "runtime-limit-cta:pre-clean" }).catch(
      () => {},
    );
    await page
      .evaluate(async () => {
        const runtimeWindow = window as typeof window & {
          __INSTAFY_RUNTIME__?: { refreshRuntimeStatuses?: () => Promise<void> };
        };
        await runtimeWindow.__INSTAFY_RUNTIME__?.refreshRuntimeStatuses?.();
      })
      .catch(() => {});

    await expect
      .poll(
        async () => {
          return await page.evaluate(() => {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_E2E__?: RuntimeE2EBridge;
            };
            return Boolean(runtimeWindow.__INSTAFY_E2E__?.ensureHostedRuntime);
          });
        },
        {
          timeout: 15_000,
          message: "runtime e2e bridge should expose ensureHostedRuntime",
        },
      )
      .toBeTruthy();

    const ensureInvokedViaBridge = await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_E2E__?: RuntimeE2EBridge;
      };
      const bridge = runtimeWindow.__INSTAFY_E2E__;
      if (!bridge?.ensureHostedRuntime) {
        return false;
      }
      return await bridge.ensureHostedRuntime();
    });
    expect(typeof ensureInvokedViaBridge).toBe("boolean");

    await expect
      .poll(() => ensureAttempts, {
        timeout: 30_000,
        message: "runtime ensure should be attempted after invoking e2e bridge",
      })
      .toBeGreaterThan(0);

    await openRuntimeSelector(page);
    await expect(page.getByText("Instafy Cloud runtime limit reached")).toBeVisible();
    await expect(
      page.getByText('2/2 Instafy Cloud runtimes are in use. The blocker is in space "Other Project".'),
    ).toBeVisible();
    await expect(page.getByText("Blocking runtime: Hosted Runtime.")).toBeVisible();
    await expect(page.getByText("Stop a stale runtime or retry after cleanup.")).toBeVisible();

    const detailsButton = page.getByRole("button", { name: "View details" });
    await expect(detailsButton).toBeVisible();
    await detailsButton.click();
    await expect(page.getByText(LIMIT_MESSAGE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide details" })).toBeVisible();

    const popover = page.getByTestId("runtime-selector-popover");
    const retryButton = popover.getByTestId("runtime-reconnect-cloud");
    await expect(retryButton).toBeVisible();

    const attemptsBeforeClickRetry = ensureAttempts;
    const retryResponse = page.waitForResponse(
      (response) => response.url().includes("/runtime/ensure") && response.request().method() === "POST",
    );
    await retryButton.click();
    await expect(
      popover.getByText("Instafy Cloud runtime limit reached", { exact: true }),
    ).toBeVisible();
    await expect(popover.getByText("Reconnecting Instafy Cloud…")).toBeVisible();
    await retryResponse;
    await expect
      .poll(() => ensureAttempts, {
        timeout: 30_000,
        message: "retry CTA should trigger another ensure request",
      })
      .toBeGreaterThan(attemptsBeforeClickRetry);
    await expect(page.getByTestId("runtime-action-error")).toContainText(
      "Runtime is still at limit",
    );
    await expect(
      page.getByTestId("status-toast").filter({ hasText: "Runtime is still at limit" }),
    ).toHaveCount(0);
    await expect(retryButton).toBeVisible();
  });

  test("can stop blocking runtime and take over from the limit card", async ({ page }) => {
    let ensureAttempts = 0;
    let stopAttempts = 0;
    let takeoverUnlocked = false;

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      ensureAttempts += 1;
      if (!takeoverUnlocked) {
        await route.fulfill({
          status: 402,
          contentType: "application/json",
          body: JSON.stringify({
            message: LIMIT_MESSAGE,
            code: "runtime_limit_reached",
            details: LIMIT_DETAILS,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtime_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          lease_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          status: "ready",
          provider: "instafy-cloud",
        }),
      });
    });

    await page.route("**/runtime/stop", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      stopAttempts += 1;
      takeoverUnlocked = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    await clearRuntimePreference(page, { projectId, source: "runtime-limit-cta-takeover" }).catch(
      () => {},
    );
    await resetRuntimeUserState(page, { source: "runtime-limit-cta-takeover:pre-clean" }).catch(
      () => {},
    );

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_E2E__?: RuntimeE2EBridge;
            };
            return Boolean(runtimeWindow.__INSTAFY_E2E__?.ensureHostedRuntime);
          }),
        {
          timeout: 15_000,
          message: "runtime e2e bridge should expose ensureHostedRuntime",
        },
      )
      .toBeTruthy();

    await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_E2E__?: RuntimeE2EBridge;
      };
      await runtimeWindow.__INSTAFY_E2E__?.ensureHostedRuntime?.();
    });

    await expect
      .poll(() => ensureAttempts, {
        timeout: 30_000,
        message: "runtime ensure should be attempted before takeover",
      })
      .toBeGreaterThan(0);

    await openRuntimeSelector(page);
    const takeoverButton = page.getByRole("button", {
      name: "Stop blocker and retry",
    });
    await expect(takeoverButton).toBeVisible();

    const ensureAttemptsBeforeTakeover = ensureAttempts;
    await takeoverButton.click();

    await expect
      .poll(() => stopAttempts, {
        timeout: 30_000,
        message: "takeover CTA should stop the blocking runtime",
      })
      .toBeGreaterThan(0);

    await expect
      .poll(() => ensureAttempts, {
        timeout: 30_000,
        message: "takeover CTA should re-attempt runtime ensure",
      })
      .toBeGreaterThan(ensureAttemptsBeforeTakeover);

    await expect(page.getByText("Instafy Cloud runtime limit reached")).toHaveCount(0);
  });

  test("stop-blocker failures stay inline in the runtime menu", async ({ page }) => {
    let ensureAttempts = 0;
    let stopAttempts = 0;

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      ensureAttempts += 1;
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({
          message: LIMIT_MESSAGE,
          code: "runtime_limit_reached",
          details: LIMIT_DETAILS,
        }),
      });
    });

    await page.route("**/runtime/stop", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      stopAttempts += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "controller stop refused" }),
      });
    });

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    await clearRuntimePreference(page, { projectId, source: "runtime-limit-cta-inline-error" }).catch(
      () => {},
    );
    await resetRuntimeUserState(page, { source: "runtime-limit-cta-inline-error:pre-clean" }).catch(
      () => {},
    );

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_E2E__?: RuntimeE2EBridge;
            };
            return Boolean(runtimeWindow.__INSTAFY_E2E__?.ensureHostedRuntime);
          }),
        {
          timeout: 15_000,
          message: "runtime e2e bridge should expose ensureHostedRuntime",
        },
      )
      .toBeTruthy();

    await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_E2E__?: RuntimeE2EBridge;
      };
      await runtimeWindow.__INSTAFY_E2E__?.ensureHostedRuntime?.();
    });

    await expect
      .poll(() => ensureAttempts, {
        timeout: 30_000,
        message: "runtime ensure should be attempted before takeover",
      })
      .toBeGreaterThan(0);

    await openRuntimeSelector(page);
    const popover = page.getByTestId("runtime-selector-popover");
    const takeoverButton = popover.getByRole("button", {
      name: "Stop blocker and retry",
    });
    await expect(takeoverButton).toBeVisible();
    await takeoverButton.click();

    await expect
      .poll(() => stopAttempts, {
        timeout: 30_000,
        message: "takeover CTA should try to stop the blocking runtime",
      })
      .toBeGreaterThan(0);

    await expect(popover.getByTestId("runtime-action-error")).toContainText(
      "Unable to take over runtime",
    );
    await expect(
      page.getByTestId("status-toast").filter({ hasText: "Unable to take over runtime" }),
    ).toHaveCount(0);
  });
});
