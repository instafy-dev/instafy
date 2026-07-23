import { expect, test, type Locator, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

const LIMIT_MESSAGE =
  "Instafy Cloud runtime limit reached for this team (2 active; max 2). Active runtime \"Hosted Runtime\" is attached to space \"Other Project\" (space bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.";
const LIMIT_DETAILS = {
  activeCount: 2,
  maxActiveCount: 2,
  blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  blockerProjectLabel: "Other Project",
  blockerRuntimeLabel: "Hosted Runtime",
};
const GENERIC_BROWSER_ERROR = "Shared Browser could not start. Please try again.";

const SAME_PROJECT_RUNTIME_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SAME_PROJECT_LEASE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SAME_PROJECT_ORIGIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function sameProjectLimitPayload(projectId: string) {
  return {
    message:
      `Instafy Cloud runtime limit reached for this organization (1 active; max 1). ` +
      `Active runtime "Hosted Runtime" is attached to project "Current Project" ` +
      `(project ${projectId}, runtime ${SAME_PROJECT_RUNTIME_ID}). ` +
      "Stop/remove that runtime, then retry.",
    code: "runtime_limit_reached",
    details: {
      activeCount: 1,
      maxActiveCount: 1,
      blockerProjectId: projectId,
      blockerRuntimeId: SAME_PROJECT_RUNTIME_ID,
      blockerProjectLabel: "Current Project",
      blockerRuntimeLabel: "Hosted Runtime",
    },
  };
}

function sameProjectRuntimeStatus(browserReady: boolean) {
  return {
    runtimes: [
      {
        runtimeId: SAME_PROJECT_RUNTIME_ID,
        status: "ready",
        provider: "instafy-cloud",
        idleTtlSeconds: 600,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        endpointUrl: null,
        taskRef: null,
        isLocal: false,
        isPreferred: true,
        health: "online",
        displayName: browserReady ? "Browser session" : "Hosted Runtime",
        runtimeImage: browserReady
          ? "ghcr.io/instafy-dev/instafy-runtime-agent:webdev"
          : "ghcr.io/instafy-dev/instafy-runtime-agent:latest",
        origin: {
          status: "ready",
          originId: SAME_PROJECT_ORIGIN_ID,
          leaseId: SAME_PROJECT_LEASE_ID,
          mode: "hosted",
          protocols: ["http"],
          endpoint: "http://127.0.0.1:65535",
          metadata: null,
        },
      },
    ],
    preferredRuntimeId: SAME_PROJECT_RUNTIME_ID,
  };
}

function sameProjectStartingRuntimeStatus() {
  const status = sameProjectRuntimeStatus(false);
  return {
    ...status,
    runtimes: status.runtimes.map((entry) => ({
      ...entry,
      status: "requested",
      health: "offline",
      origin: entry.origin
        ? {
            ...entry.origin,
            status: "requested",
          }
        : null,
    })),
  };
}

async function openBrowserSession(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("instafy:browser-open", { detail: {} }));
  });
  await expect(page.getByTestId("browser-session-modal")).toBeVisible({ timeout: 20_000 });
}

async function openInviteFromComposer(page: Page) {
  const trigger = page.getByTestId("composer-action-menu-trigger");
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  await page.getByTestId("composer-action-menu-invite").click();
  await expect(page.getByTestId("chat-invite-modal")).toBeVisible({ timeout: 20_000 });
}

async function readElementContrast(locator: Locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Unable to inspect rendered colors");
    }

    const toRgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const relativeLuminance = ([red, green, blue]: number[]) => {
      const channels = [red, green, blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };

    const style = window.getComputedStyle(element);
    const background = toRgba(style.backgroundColor);
    const foreground = toRgba(style.color);
    const backgroundLuminance = relativeLuminance(background);
    const foregroundLuminance = relativeLuminance(foreground);
    const lighter = Math.max(backgroundLuminance, foregroundLuminance);
    const darker = Math.min(backgroundLuminance, foregroundLuminance);

    return {
      background,
      backgroundLuminance,
      foreground,
      ratio: (lighter + 0.05) / (darker + 0.05),
    };
  });
}

test.describe.serial("Browser session runtime limit guidance", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "browser-session-runtime-limit:cleanup" }).catch(
      () => {},
    );
  });

  test("shows clear runtime-limit guidance in browser modal", async ({ page }) => {
    let ensureAttempts = 0;
    let stopAttempts = 0;
    let viewportOnlyRequested = false;

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      ensureAttempts += 1;
      const payload = request.postDataJSON() as {
        metadata?: { env?: Record<string, string> };
      };
      viewportOnlyRequested =
        payload.metadata?.env?.INSTAFY_BROWSER_VIEWPORT_ONLY === "1";
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
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status_changed: true, skip_reason: null }),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });
    await openBrowserSession(page);

    const modal = page.getByTestId("browser-session-modal");
    const viewport = modal.getByTestId("browser-session-viewport");
    const limitCard = modal.getByTestId("browser-runtime-limit-card");
    const notice = modal.getByTestId("browser-runtime-limit-notice");
    const viewportColors = await readElementContrast(viewport);
    const viewportChannelSpread =
      Math.max(...viewportColors.background.slice(0, 3)) -
      Math.min(...viewportColors.background.slice(0, 3));
    expect(viewportColors.background[3]).toBe(255);
    expect(viewportColors.backgroundLuminance).toBeGreaterThan(0.8);
    expect(viewportColors.backgroundLuminance).toBeLessThan(0.98);
    expect(viewportChannelSpread).toBeLessThanOrEqual(16);
    await expect(limitCard).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(notice).toBeVisible();
    await expect(notice.getByText("Cloud runtime already in use", { exact: true })).toBeVisible();
    expect(viewportOnlyRequested).toBe(true);
    await expect(
      notice.getByText("All 2 Instafy Cloud runtimes for this team are in use."),
    ).toBeVisible();
    await expect(
      notice.getByText('“Hosted Runtime” is running in “Other Project”.'),
    ).toBeVisible();
    await expect(notice).not.toContainText("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(notice).not.toContainText("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await expect(notice).not.toContainText("Stop/remove that runtime");
    expect(stopAttempts).toBe(0);
    const takeoverButton = notice.getByTestId("browser-runtime-limit-takeover");
    await expect(takeoverButton).toHaveText("Stop and open here");
    const takeoverColors = await takeoverButton.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { background: style.backgroundColor, foreground: style.color };
    });
    expect(takeoverColors.background).not.toBe(takeoverColors.foreground);

    const retryButton = notice.getByRole("button", { name: "Try again", exact: true });
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    await expect
      .poll(() => ensureAttempts, {
        timeout: 30_000,
        message: "retry action should trigger another runtime ensure attempt",
      })
      .toBeGreaterThan(1);
  });

  test("keeps runtime-limit guidance and actions legible in explicit dark theme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("instafy.themeMode", "dark");
      } catch {
        // Ignore storage-restricted bootstrap documents; the app origin remains writable.
      }
    });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({
          message: LIMIT_MESSAGE,
          code: "runtime_limit_reached",
          details: { ...LIMIT_DETAILS, blockerProjectLabel: undefined },
        }),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });
    await openBrowserSession(page);

    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const modal = page.getByTestId("browser-session-modal");
    const viewport = modal.getByTestId("browser-session-viewport");
    const scrim = modal.getByTestId("browser-runtime-limit-scrim");
    const card = modal.getByTestId("browser-runtime-limit-card");
    const notice = modal.getByTestId("browser-runtime-limit-notice");
    await expect(scrim).toBeVisible();
    const viewportColors = await readElementContrast(viewport);
    const viewportChannelSpread =
      Math.max(...viewportColors.background.slice(0, 3)) -
      Math.min(...viewportColors.background.slice(0, 3));
    expect(viewportColors.background).not.toEqual([0, 0, 0, 255]);
    expect(viewportColors.background[3]).toBe(255);
    expect(viewportColors.backgroundLuminance).toBeGreaterThan(0.002);
    expect(viewportColors.backgroundLuminance).toBeLessThan(0.04);
    expect(viewportChannelSpread).toBeLessThanOrEqual(16);
    await expect(card).toBeVisible();
    await expect(notice.getByText("Cloud runtime already in use", { exact: true })).toBeVisible();
    await expect(
      notice.getByText("All 2 Instafy Cloud runtimes for this team are in use."),
    ).toBeVisible();
    await expect(
      notice.getByText('“Hosted Runtime” is running in another space.'),
    ).toBeVisible();
    await expect(notice).not.toContainText(LIMIT_MESSAGE);
    await expect(notice).not.toContainText("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(notice).not.toContainText("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await expect(modal.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);

    const cardContrast = await readElementContrast(card);
    expect(cardContrast.background).not.toEqual([0, 0, 0, 255]);
    expect(cardContrast.background).not.toEqual([255, 255, 255, 255]);
    expect(cardContrast.background[3]).toBe(255);
    expect(cardContrast.ratio).toBeGreaterThanOrEqual(4.5);

    const scrimColors = await readElementContrast(scrim);
    expect(scrimColors.background[3]).toBeLessThan(128);

    const takeoverButton = notice.getByTestId("browser-runtime-limit-takeover");
    const retryButton = notice.getByTestId("browser-runtime-limit-retry");
    await expect(takeoverButton).toHaveText("Stop and open here");
    await expect(retryButton).toHaveText("Try again");

    for (const button of [takeoverButton, retryButton]) {
      const contrast = await readElementContrast(button);
      expect(contrast.background).not.toEqual([255, 255, 255, 255]);
      expect(contrast.background[3]).toBe(255);
      expect(contrast.foreground[3]).toBe(255);
      expect(contrast.ratio).toBeGreaterThanOrEqual(3);
    }
  });

  test("recycles an idle same-project Hosted Runtime into the browser runtime", async ({
    page,
  }) => {
    let projectId: string | null = null;
    let browserRuntimeReady = false;
    const flowEvents: string[] = [];
    const browserEnsurePayloads: Array<Record<string, unknown>> = [];
    const stopPayloads: Array<Record<string, unknown>> = [];

    await page.route("**/projects/*/runtime/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sameProjectRuntimeStatus(browserRuntimeReady)),
      });
    });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      const payload = request.postDataJSON() as Record<string, unknown>;
      const metadata = payload.metadata as Record<string, unknown> | undefined;
      if (metadata?.source !== "browser-session") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            runtime_id: SAME_PROJECT_RUNTIME_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            status: "ready",
            provider: "instafy-cloud",
          }),
        });
        return;
      }

      browserEnsurePayloads.push(payload);
      flowEvents.push("ensure");
      if (browserEnsurePayloads.length === 1) {
        await route.fulfill({
          status: 402,
          contentType: "application/json",
          body: JSON.stringify(
            sameProjectLimitPayload(projectId ?? "ffffffff-ffff-4fff-8fff-ffffffffffff"),
          ),
        });
        return;
      }

      browserRuntimeReady = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtime_id: SAME_PROJECT_RUNTIME_ID,
          lease_id: SAME_PROJECT_LEASE_ID,
          status: "requested",
          provider: "instafy-cloud",
          scope: "exclusive",
          origin: {
            status: "ready",
            origin_id: SAME_PROJECT_ORIGIN_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            mode: "hosted",
            protocols: ["http"],
            endpoint: "http://127.0.0.1:65535",
          },
        }),
      });
    });

    await page.route("**/runtime/stop", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      stopPayloads.push(request.postDataJSON() as Record<string, unknown>);
      flowEvents.push("stop");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status_changed: true, skip_reason: null }),
      });
    });

    projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();
    await openBrowserSession(page);

    await expect
      .poll(() => browserEnsurePayloads.length, {
        timeout: 30_000,
        message: "browser ensure should retry after recycling the same-project runtime",
      })
      .toBe(2);

    expect(stopPayloads).toHaveLength(1);
    expect(stopPayloads[0]).toMatchObject({
      runtime_id: SAME_PROJECT_RUNTIME_ID,
      reason: "runtime_limit_takeover",
      skip_if_active_jobs: true,
      expected_project_id: projectId,
      expected_provider: "instafy-cloud",
      expected_display_name: "Hosted Runtime",
    });
    expect(browserEnsurePayloads[1]).toMatchObject({
      runtime_id: SAME_PROJECT_RUNTIME_ID,
    });
    expect(flowEvents).toEqual(["ensure", "stop", "ensure"]);
    await expect(
      page
        .getByTestId("browser-session-modal")
        .getByText("Cloud runtime already in use", { exact: true }),
    ).toHaveCount(0);
  });

  test("refreshes a stale snapshot and recycles a starting same-project Hosted Runtime", async ({
    page,
  }) => {
    let projectId: string | null = null;
    let browserLimitObserved = false;
    let browserRuntimeReady = false;
    let statusRequestsAfterLimit = 0;
    const browserEnsurePayloads: Array<Record<string, unknown>> = [];
    const stopPayloads: Array<Record<string, unknown>> = [];

    await page.route("**/projects/*/runtime/status", async (route) => {
      if (browserRuntimeReady) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(sameProjectRuntimeStatus(true)),
        });
        return;
      }
      if (browserLimitObserved) {
        statusRequestsAfterLimit += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(sameProjectStartingRuntimeStatus()),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runtimes: [], preferredRuntimeId: null }),
      });
    });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      const payload = request.postDataJSON() as Record<string, unknown>;
      const metadata = payload.metadata as Record<string, unknown> | undefined;
      if (metadata?.source !== "browser-session") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            runtime_id: SAME_PROJECT_RUNTIME_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            status: "requested",
            provider: "instafy-cloud",
          }),
        });
        return;
      }

      browserEnsurePayloads.push(payload);
      if (browserEnsurePayloads.length === 1) {
        browserLimitObserved = true;
        await route.fulfill({
          status: 402,
          contentType: "application/json",
          body: JSON.stringify(
            sameProjectLimitPayload(projectId ?? "ffffffff-ffff-4fff-8fff-ffffffffffff"),
          ),
        });
        return;
      }

      browserRuntimeReady = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtime_id: SAME_PROJECT_RUNTIME_ID,
          lease_id: SAME_PROJECT_LEASE_ID,
          status: "requested",
          provider: "instafy-cloud",
          scope: "exclusive",
          origin: {
            status: "ready",
            origin_id: SAME_PROJECT_ORIGIN_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            mode: "hosted",
            protocols: ["http"],
            endpoint: "http://127.0.0.1:65535",
          },
        }),
      });
    });

    await page.route("**/runtime/stop", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      stopPayloads.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status_changed: true, skip_reason: null }),
      });
    });

    projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();
    await openBrowserSession(page);

    await expect
      .poll(() => browserEnsurePayloads.length, {
        timeout: 30_000,
        message: "browser ensure should retry after refreshing the limit blocker",
      })
      .toBe(2);
    expect(statusRequestsAfterLimit).toBeGreaterThan(0);
    expect(stopPayloads).toHaveLength(1);
    expect(stopPayloads[0]).toMatchObject({
      runtime_id: SAME_PROJECT_RUNTIME_ID,
      reason: "runtime_limit_takeover",
      skip_if_active_jobs: true,
      expected_project_id: projectId,
      expected_provider: "instafy-cloud",
      expected_display_name: "Hosted Runtime",
    });
    expect(browserEnsurePayloads[1]).toMatchObject({
      runtime_id: SAME_PROJECT_RUNTIME_ID,
    });
    await expect(
      page
        .getByTestId("browser-session-modal")
        .getByTestId("browser-runtime-limit-notice"),
    ).toHaveCount(0);
  });

  test("does not let generic runtime recovery race the browser relaunch after recycling", async ({
    page,
  }) => {
    let projectId: string | null = null;
    let runtimeStopped = false;
    let browserRuntimeReady = false;
    let releaseBrowserRelaunch: (() => void) | null = null;
    const browserRelaunchGate = new Promise<void>((resolve) => {
      releaseBrowserRelaunch = resolve;
    });
    const browserEnsurePayloads: Array<Record<string, unknown>> = [];
    const genericEnsurePayloadsAfterStop: Array<Record<string, unknown>> = [];

    await page.route("**/projects/*/runtime/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          runtimeStopped && !browserRuntimeReady
            ? { runtimes: [], preferredRuntimeId: null }
            : sameProjectRuntimeStatus(browserRuntimeReady),
        ),
      });
    });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      const payload = request.postDataJSON() as Record<string, unknown>;
      const metadata = payload.metadata as Record<string, unknown> | undefined;
      if (metadata?.source !== "browser-session") {
        if (runtimeStopped) {
          genericEnsurePayloadsAfterStop.push(payload);
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            runtime_id: SAME_PROJECT_RUNTIME_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            status: "requested",
            provider: "instafy-cloud",
          }),
        });
        return;
      }

      browserEnsurePayloads.push(payload);
      if (browserEnsurePayloads.length === 1) {
        await route.fulfill({
          status: 402,
          contentType: "application/json",
          body: JSON.stringify(
            sameProjectLimitPayload(projectId ?? "ffffffff-ffff-4fff-8fff-ffffffffffff"),
          ),
        });
        return;
      }

      await browserRelaunchGate;
      browserRuntimeReady = true;
      runtimeStopped = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtime_id: SAME_PROJECT_RUNTIME_ID,
          lease_id: SAME_PROJECT_LEASE_ID,
          status: "requested",
          provider: "instafy-cloud",
          scope: "exclusive",
          origin: {
            status: "ready",
            origin_id: SAME_PROJECT_ORIGIN_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            mode: "hosted",
            protocols: ["http"],
            endpoint: "http://127.0.0.1:65535",
          },
        }),
      });
    });

    await page.route("**/runtime/stop", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      runtimeStopped = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status_changed: true, skip_reason: null }),
      });
    });

    projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_RUNTIME__?: {
                getSnapshot?: () => {
                  runtimeReady?: boolean;
                  hostedRuntimeEnsuring?: boolean;
                };
              };
            };
            const snapshot = runtimeWindow.__INSTAFY_RUNTIME__?.getSnapshot?.();
            return {
              runtimeReady: snapshot?.runtimeReady ?? false,
              hostedRuntimeEnsuring: snapshot?.hostedRuntimeEnsuring ?? true,
            };
          }),
        {
          timeout: 30_000,
          message: "generic Hosted Runtime should settle before browser takeover begins",
        },
      )
      .toEqual({ runtimeReady: true, hostedRuntimeEnsuring: false });
    await openBrowserSession(page);

    await expect
      .poll(() => browserEnsurePayloads.length, {
        timeout: 30_000,
        message: "browser relaunch should be waiting after the same-project runtime stops",
      })
      .toBe(2);

    await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_RUNTIME__?: { refreshRuntimeStatuses?: () => Promise<void> };
      };
      await runtimeWindow.__INSTAFY_RUNTIME__?.refreshRuntimeStatuses?.();
    });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_RUNTIME__?: {
                getSnapshot?: () => {
                  runtimeReady?: boolean;
                  hostedRuntimeEnsuring?: boolean;
                  runtimeStatuses?: unknown[];
                };
              };
            };
            const snapshot = runtimeWindow.__INSTAFY_RUNTIME__?.getSnapshot?.();
            return {
              runtimeReady: snapshot?.runtimeReady ?? true,
              hostedRuntimeEnsuring: snapshot?.hostedRuntimeEnsuring ?? true,
              runtimeStatusCount: snapshot?.runtimeStatuses?.length ?? -1,
            };
          }),
        {
          timeout: 10_000,
          message: "generic runtime recovery should observe the released runtime slot",
        },
      )
      .toEqual({
        runtimeReady: false,
        hostedRuntimeEnsuring: false,
        runtimeStatusCount: 0,
      });
    await page.waitForTimeout(1_000);

    releaseBrowserRelaunch?.();
    await expect
      .poll(() => browserRuntimeReady, {
        timeout: 30_000,
        message: "browser runtime relaunch should complete after the race window",
      })
      .toBe(true);

    expect(genericEnsurePayloadsAfterStop).toHaveLength(0);
  });

  test("keeps the manual takeover action when the same-project runtime is busy", async ({
    page,
  }) => {
    let projectId: string | null = null;
    const browserEnsurePayloads: Array<Record<string, unknown>> = [];
    const stopPayloads: Array<Record<string, unknown>> = [];

    await page.route("**/projects/*/runtime/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sameProjectRuntimeStatus(false)),
      });
    });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      const payload = request.postDataJSON() as Record<string, unknown>;
      const metadata = payload.metadata as Record<string, unknown> | undefined;
      if (metadata?.source !== "browser-session") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            runtime_id: SAME_PROJECT_RUNTIME_ID,
            lease_id: SAME_PROJECT_LEASE_ID,
            status: "ready",
            provider: "instafy-cloud",
          }),
        });
        return;
      }

      browserEnsurePayloads.push(payload);
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify(
          sameProjectLimitPayload(projectId ?? "ffffffff-ffff-4fff-8fff-ffffffffffff"),
        ),
      });
    });

    await page.route("**/runtime/stop", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      stopPayloads.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status_changed: false,
          skip_reason: "active_jobs",
        }),
      });
    });

    projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();
    await openBrowserSession(page);

    const modal = page.getByTestId("browser-session-modal");
    await expect(modal.getByText("Cloud runtime already in use", { exact: true })).toBeVisible();
    await expect(
      modal.getByRole("button", { name: "Stop and open here", exact: true }),
    ).toBeVisible();
    expect(browserEnsurePayloads).toHaveLength(1);
    expect(stopPayloads).toHaveLength(1);
    expect(stopPayloads[0]).toMatchObject({
      runtime_id: SAME_PROJECT_RUNTIME_ID,
      reason: "runtime_limit_takeover",
      skip_if_active_jobs: true,
      expected_project_id: projectId,
      expected_provider: "instafy-cloud",
      expected_display_name: "Hosted Runtime",
    });
  });

  test("composer action menu exposes browser and slash command launchers", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    const trigger = page.getByTestId("composer-action-menu-trigger");
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();

    const menu = page.getByTestId("composer-action-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("composer-action-menu-open-browser")).toBeVisible();
    await expect(page.getByTestId("composer-action-menu-open-new-browser")).toBeVisible();
    await expect(page.getByTestId("composer-action-menu-invite")).toBeVisible();

    await page.getByTestId("composer-action-menu-commands").click();
    await expect(page.getByTestId("composer-action-menu-command-learn")).toBeVisible();
    await page.getByTestId("composer-action-menu-command-terminal").click();

    await expect(page.getByTestId("chat-input")).toContainText("/terminal");
  });

  test("composer invite modal keeps nearby actions compact until needed", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
    await openInviteFromComposer(page);

    const modal = page.getByTestId("chat-invite-modal");
    await expect(modal.getByRole("heading", { name: "Invite", exact: true })).toBeVisible();
    await expect(modal.getByTestId("composer-invite-access-role-viewer")).toBeVisible();
    await expect(modal.getByTestId("composer-invite-access-role-builder")).toBeVisible();
    await expect(modal.getByTestId("composer-invite-copy-link")).toBeVisible();
    await expect(modal.getByText("Link", { exact: true })).toBeVisible();
    await expect(modal.getByText(/Ready|Create/)).toBeVisible();
    await expect(modal.getByText("QR or share", { exact: true })).toBeVisible();
    await expect(modal.getByTestId("composer-invite-nearby-show-qr")).toBeVisible();
    await expect(modal.getByTestId("composer-invite-nearby-qr-modal")).toBeHidden();
    await expect(modal.getByTestId("composer-invite-email-input")).toBeVisible();
    await expect(modal.getByTestId("composer-invite-email-submit")).toBeVisible();
    await expect(modal.getByTestId("composer-invite-open-settings")).toBeVisible();
  });

  test("composer invite modal opens a dedicated QR sheet and can share from there", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });

    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "share", {
        configurable: true,
        writable: true,
        value: async (payload: unknown) => {
          (window as typeof window & { __instafySharedPayload?: unknown }).__instafySharedPayload = payload;
        },
      });
      Object.defineProperty(window.navigator, "canShare", {
        configurable: true,
        writable: true,
        value: () => true,
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });
    await openInviteFromComposer(page);

    const modal = page.getByTestId("chat-invite-modal");
    const qrButton = modal.getByTestId("composer-invite-nearby-show-qr");
    await expect(modal.getByText("QR or share", { exact: true })).toBeVisible();
    await expect(qrButton).toBeVisible();

    await qrButton.click();

    const qrModal = page.getByTestId("composer-invite-nearby-qr-modal");
    await expect(qrModal).toBeVisible();
    await expect(qrModal.getByTestId("composer-invite-nearby-qr")).toBeVisible();
    await expect(qrModal.getByText("Scan on the other device.")).toBeVisible();
    const qrModalBox = await qrModal.boundingBox();
    expect(qrModalBox?.height ?? 0).toBeGreaterThan(780);

    const qrUrl = await qrModal.getByTestId("composer-invite-nearby-url").textContent();
    expect(qrUrl).toContain("/invite?token=");

    const nearbyShareButton = qrModal.getByTestId("composer-invite-nearby-share-from-qr");
    await expect(nearbyShareButton).toBeVisible();
    await nearbyShareButton.click();

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as typeof window & { __instafySharedPayload?: { url?: string } }).__instafySharedPayload?.url ??
              null,
          ),
        {
          timeout: 30_000,
          message: "nearby share should receive an invite link payload",
        },
      )
      .toContain("/invite?token=");

    const payload = await page.evaluate(
      () => (window as typeof window & { __instafySharedPayload?: { title?: string; text?: string; url?: string } }).__instafySharedPayload,
    );
    expect(payload?.title).toContain("Instafy");
    expect(payload?.text).toContain("nearby device");
  });

  test("desktop browser surface preserves composer clearance across subtabs", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 720 });

    let ensureAttempts = 0;
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

    await prepareStudio(page, { waitForHostedRuntime: false });
    await openBrowserSession(page);

    const panel = page.getByTestId("browser-session-modal");
    const stage = page.getByTestId("browser-session-stage");
    const collapsedCard = page.getByTestId("browser-session-collapsed-card");
    const browserTab = page.getByTestId("conversation-subtab-browser");
    const chatTab = page.getByTestId("conversation-subtab-chat");
    await expect(panel).toBeVisible();
    await expect(stage).toBeVisible();
    await expect(collapsedCard).toHaveCount(0);
    await expect(panel.getByText("Cloud runtime already in use", { exact: true })).toBeVisible();
    await expect(browserTab).toHaveAttribute("aria-selected", "true");

    const stageBox = await stage.boundingBox();
    const composerBox = await page.getByTestId("chat-composer-overlay").boundingBox();
    expect(stageBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect((stageBox?.y ?? 0) + (stageBox?.height ?? 0)).toBeLessThanOrEqual(composerBox?.y ?? 0);

    await expect(page.getByTestId("chat-composer-overlay")).toBeVisible();
    await expect(panel).toBeVisible();

    const attemptsBeforeSwitch = ensureAttempts;
    await panel.getByTestId("browser-session-fullscreen-toggle").click();
    const fullscreenDialog = page.getByRole("dialog", { name: "Browser session" });
    await expect(fullscreenDialog).toBeVisible();
    await fullscreenDialog.getByRole("button", { name: "Back to chat" }).click();
    await expect(fullscreenDialog).toHaveCount(0);
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("chat-message-scroll")).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(panel).toHaveCount(1);

    await browserTab.click();
    await expect(browserTab).toHaveAttribute("aria-selected", "true");
    await expect(panel).toBeVisible();
    await expect.poll(() => ensureAttempts).toBe(attemptsBeforeSwitch);
  });

  test("mobile-width browser stays inline and can return to Chat", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
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

    await prepareStudio(page, { waitForHostedRuntime: false });
    await openBrowserSession(page);

    const modal = page.getByTestId("browser-session-modal");
    const collapsedCard = page.getByTestId("browser-session-collapsed-card");
    const browserTab = page.getByTestId("conversation-subtab-browser");
    const chatTab = page.getByTestId("conversation-subtab-chat");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(collapsedCard).toHaveCount(0);
    await expect(modal.getByText("Cloud runtime already in use", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Browser session" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Browser session" })).toBeVisible();
    await expect(browserTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("browser-transport-shared")).toBeVisible();
    await expect(page.getByTestId("browser-transport-shared")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("browser-identity-badge")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);

    await chatTab.click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("chat-message-scroll")).toBeVisible();
    await expect(modal).toBeHidden();
    await expect(modal).toHaveCount(1);

    await browserTab.click();
    await modal.getByRole("button", { name: "Back to chat" }).click();
    await expect(page.getByTestId("chat-message-scroll")).toBeVisible();
    await expect(modal).toBeHidden();
    await expect(modal).toHaveCount(1);

    await browserTab.click();
    await expect(modal).toBeVisible();
  });

  test("short-height browser stays inline without trapping the conversation tabs", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
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

    await prepareStudio(page, { waitForHostedRuntime: false });
    await openBrowserSession(page);

    const modal = page.getByTestId("browser-session-modal");
    const collapsedCard = page.getByTestId("browser-session-collapsed-card");
    const inlineStage = page.getByTestId("browser-session-stage");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(collapsedCard).toHaveCount(0);
    await expect(inlineStage).toBeVisible();
    await expect(modal.getByText("Cloud runtime already in use", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Browser session" })).toHaveCount(0);
    await expect(page.getByTestId("conversation-subtabs")).toBeVisible();
    await expect(page.getByTestId("conversation-subtab-browser")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId("conversation-subtab-chat").click();
    await expect(page.getByTestId("chat-message-scroll")).toBeVisible();
  });
});

test.describe.serial("Shared Browser disconnected presentation", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "browser-session-disconnected:cleanup" }).catch(
      () => {},
    );
  });

  for (const themeMode of ["light", "dark"] as const) {
    test(`keeps loading and ordinary errors legible in ${themeMode} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.addInitScript((mode) => {
        try {
          window.localStorage.setItem("instafy.themeMode", mode);
        } catch {
          // Ignore storage-restricted bootstrap documents; the app origin remains writable.
        }
      }, themeMode);

      let releaseBrowserEnsure: (() => void) | null = null;
      let resolveBrowserEnsureStarted: (() => void) | null = null;
      const browserEnsureStarted = new Promise<void>((resolveStarted) => {
        resolveBrowserEnsureStarted = resolveStarted;
      });
      await page.route("**/runtime/ensure", async (route, request) => {
        if (request.method().toUpperCase() !== "POST") {
          await route.continue();
          return;
        }

        const payload = request.postDataJSON() as {
          metadata?: { source?: string };
        };
        if (payload.metadata?.source !== "browser-session") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: GENERIC_BROWSER_ERROR }),
          });
          return;
        }

        resolveBrowserEnsureStarted?.();
        await new Promise<void>((resolveRelease) => {
          releaseBrowserEnsure = resolveRelease;
        });
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: GENERIC_BROWSER_ERROR }),
        });
      });

      await prepareStudio(page, { waitForHostedRuntime: false });
      await openBrowserSession(page);
      await browserEnsureStarted;

      await expect(page.locator("html")).toHaveClass(
        themeMode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
      const modal = page.getByTestId("browser-session-modal");
      const viewport = modal.getByTestId("browser-session-viewport");
      const card = modal.getByTestId("browser-session-state-card");
      const loading = modal.getByTestId("browser-session-loading-notice");
      await expect(card).toBeVisible();
      await expect(loading).toBeVisible();
      await expect(loading.getByText("Starting Shared Browser", { exact: true })).toBeVisible();
      await expect(
        loading.getByText("Preparing a secure browser session…", { exact: true }),
      ).toBeVisible();

      const viewportColors = await readElementContrast(viewport);
      const cardColors = await readElementContrast(card);
      expect(viewportColors.background).not.toEqual([0, 0, 0, 255]);
      expect(cardColors.background).not.toEqual([0, 0, 0, 255]);
      if (themeMode === "light") {
        expect(viewportColors.backgroundLuminance).toBeGreaterThan(0.8);
        await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
      } else {
        expect(viewportColors.backgroundLuminance).toBeGreaterThan(0.002);
        expect(viewportColors.backgroundLuminance).toBeLessThan(0.04);
        expect(cardColors.background).not.toEqual([255, 255, 255, 255]);
      }
      expect(cardColors.ratio).toBeGreaterThanOrEqual(4.5);

      expect(releaseBrowserEnsure).not.toBeNull();
      releaseBrowserEnsure?.();

      const errorNotice = modal.getByTestId("browser-session-error-notice");
      await expect(errorNotice).toBeVisible({ timeout: 30_000 });
      await expect(errorNotice.getByText("Browser unavailable", { exact: true })).toBeVisible();
      await expect(errorNotice.getByText(GENERIC_BROWSER_ERROR, { exact: true })).toBeVisible();
      const retryButton = errorNotice.getByTestId("browser-session-error-retry");
      await expect(retryButton).toBeVisible();
      await expect(retryButton).toHaveText("Try again");
      const retryColors = await readElementContrast(retryButton);
      expect(retryColors.background).not.toEqual([255, 255, 255, 255]);
      expect(retryColors.background).not.toEqual(retryColors.foreground);
      expect(retryColors.ratio).toBeGreaterThanOrEqual(3);
    });
  }
});
