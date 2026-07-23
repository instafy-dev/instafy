import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { dismissToastIfVisible } from "../utils/toasts.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const CREDENTIAL_ID = "99999999-9999-4999-8999-999999999999";

test.describe("Credential menu inline testing (mobile)", () => {
  test.setTimeout(120_000);

  test("keeps menu open and renders inline test failure without toast", async ({ page }) => {
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

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });

    await dismissToastIfVisible(page);

    await page.getByTestId(`credentials-connection-menu-${CREDENTIAL_ID}`).click();
    const testItem = page.getByRole("menuitem", { name: "Test" });
    await expect(testItem).toBeVisible();
    await testItem.click();

    await expect
      .poll(() => testCalls, {
        timeout: 30_000,
        message: "credential test endpoint should be called from mobile menu action",
      })
      .toBe(1);

    await expect(page.getByRole("menuitem", { name: /Remove/i })).toBeVisible();
    await expect(page.getByTestId(`credentials-connection-test-result-mobile-${CREDENTIAL_ID}`)).toContainText(
      "Failed",
    );
    await expect(page.getByTestId(`credentials-connection-test-result-${CREDENTIAL_ID}`)).toContainText("Failed");
    await expect(page.getByRole("menuitem", { name: failureMessage })).toBeVisible();

    await page.waitForTimeout(250);
    await expect(page.getByTestId("status-toast")).toHaveCount(0);
  });
});
