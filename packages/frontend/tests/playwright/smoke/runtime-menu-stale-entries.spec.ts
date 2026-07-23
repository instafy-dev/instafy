import { expect, test, type Page } from "@playwright/test";
import { clearRuntimePreference, prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

function toIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

type RuntimeE2EWindow = Window & {
  __INSTAFY_RUNTIME__?: { refreshRuntimeStatuses?: () => Promise<void> };
};

async function refreshRuntimeStatuses(page: Page) {
  await page.evaluate(async () => {
    const runtimeWindow = window as RuntimeE2EWindow;
    await runtimeWindow.__INSTAFY_RUNTIME__?.refreshRuntimeStatuses?.();
  });
}

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

test.describe.serial("Runtime menu stale entries", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "runtime-menu-stale-entries:cleanup" }).catch(
      () => {},
    );
  });

  test("dedupes stale hosted runtime entries in the selector", async ({ page }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();

    await clearRuntimePreference(page, {
      projectId,
      source: "runtime-menu-stale-entries",
    }).catch(() => {});
    await resetRuntimeUserState(page, { source: "runtime-menu-stale-entries:pre-clean" }).catch(
      () => {},
    );

    const staleCreatedAt = toIso(40);
    const staleLastSeenAt = toIso(35);

    await page.route(`**/projects/${projectId}/runtime/status`, async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtimes: [
            {
              runtimeId: "10000000-0000-4000-8000-000000000001",
              status: "requested",
              provider: "instafy-cloud",
              idleTtlSeconds: 300,
              createdAt: staleCreatedAt,
              lastSeenAt: staleLastSeenAt,
              endpointUrl: null,
              taskRef: null,
              isLocal: false,
              isPreferred: false,
              health: "offline",
              displayName: null,
            },
            {
              runtimeId: "10000000-0000-4000-8000-000000000002",
              status: "requesting",
              provider: "instafy-cloud",
              idleTtlSeconds: 300,
              createdAt: staleCreatedAt,
              lastSeenAt: staleLastSeenAt,
              endpointUrl: null,
              taskRef: null,
              isLocal: false,
              isPreferred: false,
              health: "offline",
              displayName: null,
            },
            {
              runtimeId: "10000000-0000-4000-8000-000000000003",
              status: "stopped",
              provider: "instafy-cloud",
              idleTtlSeconds: 300,
              createdAt: staleCreatedAt,
              lastSeenAt: staleLastSeenAt,
              endpointUrl: null,
              taskRef: null,
              isLocal: false,
              isPreferred: false,
              health: "offline",
              displayName: null,
            },
          ],
          preferredRuntimeId: null,
        }),
      });
    });

    await page.route("**/runtime/ensure", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtime_id: "20000000-0000-4000-8000-000000000001",
          lease_id: "30000000-0000-4000-8000-000000000001",
          status: "ready",
          provider: "instafy-cloud",
        }),
      });
    });

    await refreshRuntimeStatuses(page);
    await refreshRuntimeStatuses(page);

    await openRuntimeSelector(page);
    const popover = page.getByTestId("runtime-selector-popover");

    await expect(popover.locator('span[title="Instafy Cloud runtime"]')).toHaveCount(1);
  });
});
