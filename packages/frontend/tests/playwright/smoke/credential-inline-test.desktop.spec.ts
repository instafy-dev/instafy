import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { dismissToastIfVisible } from "../utils/toasts.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const CREDENTIAL_ID = "88888888-8888-4888-8888-888888888888";

test.describe("Credential inline testing (desktop)", () => {
  test.setTimeout(120_000);

  test("renders inline test status row in desktop layout without toast", async ({ page }) => {
    let testCalls = 0;
    const failureMessage = "Invalid API key";

    await page.route("**/me/credentials", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      if (!url.pathname.endsWith("/me/credentials")) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: CREDENTIAL_ID,
            kind: "openai_api_key",
            label: "Gemini",
            isDefault: true,
            metadata: { provider: "gemini" },
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
      });
    });

    await page.route("**/me/agents", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    });

    await page.route("**/me/credentials/*/test", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      testCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          provider: "gemini",
          output: failureMessage,
          elapsedMs: 12,
        }),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });
    await page.setViewportSize({ width: 1280, height: 900 });

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await dismissToastIfVisible(page);

    await page.getByTestId(`credentials-connection-test-${CREDENTIAL_ID}`).click();

    await expect
      .poll(() => testCalls, {
        timeout: 30_000,
        message: "credential test endpoint should be called from desktop test action",
      })
      .toBe(1);

    await expect(page.getByTestId(`credentials-connection-test-result-${CREDENTIAL_ID}`)).toContainText("Failed");
    await expect(page.getByTestId(`credentials-connection-test-result-${CREDENTIAL_ID}`)).toContainText(
      failureMessage,
    );

    await page.waitForTimeout(250);
    await expect(page.getByTestId("status-toast")).toHaveCount(0);
  });
});
