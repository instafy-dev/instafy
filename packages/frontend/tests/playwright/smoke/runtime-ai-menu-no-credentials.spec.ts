import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";

test.describe("Runtime & AI menu", () => {
  test.setTimeout(120_000);

  test("treats managed AI as ready without requiring BYOC setup", async ({ page }) => {
    await page.route("**/credits/status**", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      if (!url.pathname.endsWith("/credits/status")) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          balance: 12,
          creditLimit: 20,
          lastBurnAt: null,
          lastRefillAt: null,
          subscription: null,
        }),
      });
    });

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
        body: JSON.stringify([]),
      });
    });

    await page.route("**/me/agents", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.route("**/me/credentials/requirements", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requiresUserCredentials: false,
          proxyBackend: "remote_static",
          hasDefaultCredential: false,
          managedAi: {
            enabled: true,
            available: true,
            label: "Instafy AI",
            creditBurnAmount: 1,
            dailyPromptLimit: 20,
            dailyPromptsUsed: 0,
            remainingPrompts: 20,
          },
          error: null,
        }),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    const onboarding = page.getByTestId("onboarding-getting-started");
    await expect(onboarding).toBeVisible();
    await expect(onboarding.getByTestId("onboarding-use-managed-ai")).toContainText(
      "20 of 20 free prompts left today",
    );
    await expect(onboarding.getByTestId("onboarding-connect-own-ai")).toBeVisible();
    await expect(page.getByTestId("credentials-status-indicator")).toHaveCount(0);

    await onboarding.getByTestId("onboarding-connect-own-ai").click();
    const credentialWizard = page.getByTestId("credentials-connect-modal");
    await expect(credentialWizard).toBeVisible();
    await expect(credentialWizard).toContainText("Add AI connection");
    await expect(credentialWizard.getByTestId("credentials-connect-choice-codex")).toBeVisible();
    await expect(credentialWizard.getByText("Use free Instafy AI", { exact: false })).toHaveCount(0);
    await credentialWizard.getByRole("button", { name: "Close" }).click();
    await expect(onboarding).toBeVisible();

    // Selecting the included lane is persisted client-side (managedAiSelected
    // localStorage key), not via a server RPC, so just assert the resulting
    // transition into the workspace step.
    await onboarding.getByTestId("onboarding-use-managed-ai").click();
    await expect(onboarding.getByTestId("onboarding-ai-choice")).toHaveCount(0);
    await expect(
      onboarding.getByText("What should your agent work on?", { exact: true }),
    ).toBeVisible();
    // Focus hands off to the workspace step, not the composer (which would open
    // the mobile keyboard over the next decision).
    await expect(onboarding.getByTestId("onboarding-workspace-step")).toBeFocused();

    await page.getByTestId("runtime-selector-button").first().click();
    const popover = page.getByTestId("runtime-selector-popover");
    await expect(popover).toBeVisible();

    const creditsRow = popover.getByTestId("runtime-ai-credits-row");
    await expect(creditsRow).toBeVisible();
    await expect(creditsRow).toContainText("12/20 credits left");
    await expect(page.getByTestId("chat-out-of-credits-cta")).toHaveCount(0);

    await expect(popover.getByTestId("runtime-ai-setup-card")).toHaveCount(0);
    await expect(popover.getByTestId("runtime-ai-connect-button")).toHaveCount(0);

    const toggle = popover.getByTestId("chat-assistant-toggle");
    const toggleSwitch = toggle.locator('input[role="switch"]');
    await expect(toggle).toBeVisible();
    if (await toggleSwitch.isChecked()) {
      await toggle.click();
      await expect(toggleSwitch).not.toBeChecked();
    }
    await toggle.click();
    await expect(toggleSwitch).toBeChecked();
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("runtime-ai-setup-card")).toHaveCount(0);

    // The included-AI selection persists client-side (managedAiSelected
    // localStorage key), so a reload must recover it: the AI choice stays
    // settled and onboarding lands directly on the workspace step.
    await page.reload();
    const reloadedOnboarding = page.getByTestId("onboarding-getting-started");
    await expect(reloadedOnboarding).toBeVisible();
    await expect(reloadedOnboarding.getByTestId("onboarding-ai-choice")).toHaveCount(0);
    await expect(
      reloadedOnboarding.getByText("What should your agent work on?", { exact: true }),
    ).toBeVisible();
  });

  test("still lets chat disable Octo when no AI credentials are onboarded", async ({ page }) => {
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
        body: JSON.stringify([]),
      });
    });

    await page.route("**/me/agents", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.route("**/me/credentials/requirements", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requiresUserCredentials: true,
          proxyBackend: "codex",
          error: null,
        }),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("runtime-selector-button").first().click();
    const popover = page.getByTestId("runtime-selector-popover");
    await expect(popover).toBeVisible();

    await expect(popover.getByTestId("runtime-ai-setup-card")).toBeVisible();
    await expect(popover.getByTestId("runtime-ai-connect-button")).toBeVisible();
    await expect(popover.getByTestId("octo-agent-model-select")).toHaveCount(0);
    const toggle = popover.getByTestId("chat-assistant-toggle");
    const toggleSwitch = toggle.locator('input[role="switch"]');
    await expect(toggle).toBeVisible();
    await expect(toggleSwitch).toBeChecked();
    await toggle.click();
    await expect(toggleSwitch).not.toBeChecked();

    await page.getByTestId("chat-input").click();
    await expect(popover).toBeHidden({ timeout: 5_000 });

    const prompt = `plain chat without ai ${Date.now()}`;
    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId("chat-send-button").click();
    await expect(page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: prompt }).last()).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    await page.getByTestId("runtime-selector-button").first().click();
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("runtime-ai-connect-button")).toBeVisible();
  });
});
