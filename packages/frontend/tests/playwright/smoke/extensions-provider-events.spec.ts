import { expect, test } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

test.describe("Extensions provider events", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "extensions-provider-events:cleanup" }).catch(() => {});
  });

  async function openExtensions(page: import("@playwright/test").Page) {
    await openSidebarSecondaryItem(page, "extensions");
    await expect(page.getByTestId("extensions-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("extensions-provider-access-section")).toBeVisible({
      timeout: 15_000,
    });
  }

  test("developer details can emit and bound synthetic provider events", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
    await openExtensions(page);

    await page.getByTestId("extensions-developer-toggle").click();
    const debugPanel = page.getByTestId("provider-event-debug-panel");
    await expect(debugPanel).toBeVisible({ timeout: 15_000 });
    await expect(debugPanel).toContainText("No provider events captured yet.");

    await page.getByTestId("provider-event-emit-camera").click();
    const firstEntry = page.getByTestId("provider-event-log-entry-0");
    await expect(firstEntry).toContainText("Surface in chat");
    await expect(firstEntry).toContainText("Rear photo captured");

    await page.getByTestId("provider-event-emit-wake-word").click();
    await expect(page.getByTestId("provider-trigger-queue-panel")).toContainText("Pending sensor triggers");
    await expect(page.getByTestId("provider-trigger-queue-entry-0")).toContainText("Trigger candidate");
    await expect(page.getByTestId("provider-trigger-queue-entry-0")).toContainText(
      "Audio Wake Word Detected",
    );
    await expect(firstEntry).toContainText("Trigger candidate");

    await page.getByTestId("provider-trigger-queue-dismiss-0").click();
    await expect(page.getByTestId("provider-trigger-queue-panel")).toHaveCount(0);
    await expect(firstEntry).toContainText("Audio Wake Word Detected");

    await page.getByTestId("provider-event-emit-telemetry").click();
    await expect(firstEntry).toContainText("Recorded only");
    await expect(firstEntry).toContainText("Robot Telemetry Sampled");
    await expect(firstEntry).toContainText("8x");

    await page.getByTestId("provider-event-clear-log").click();
    await expect(debugPanel).toContainText("No provider events captured yet.");
  });
});
