import { expect, test, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

const CONNECTED_AI_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

async function installConnectedAiCredentialRoutes(page: Page) {
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
          id: CONNECTED_AI_CREDENTIAL_ID,
          kind: "codex_auth_json",
          label: "Connected AI test fixture",
          isDefault: true,
          metadata: { provider: "openai" },
          lastUsedAt: null,
          revokedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
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
        proxyBackend: "remote_dynamic",
        hasDefaultCredential: true,
        managedAi: {
          enabled: true,
          available: false,
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
}

test.describe("Chat onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await installConnectedAiCredentialRoutes(page);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-onboarding:cleanup" }).catch(() => {});
  });

  test("offers one row of live tools, and leaves the blank path to the composer", async ({ page }) => {
    const onboarding = page.getByTestId("onboarding-getting-started");
    await expect(onboarding).toBeVisible();
    await expect(onboarding.getByRole("button", { name: "VS Code extension" })).toHaveCount(0);
    await expect(
      onboarding.getByText("Start with a tool you already use", { exact: true }),
    ).toBeVisible();
    // Topic paths and the two action cards are gone; one chip row replaced them.
    await expect(onboarding.getByTestId("onboarding-path-finance")).toHaveCount(0);
    await expect(onboarding.getByTestId("onboarding-path-coding")).toHaveCount(0);
    await expect(onboarding.getByTestId("onboarding-action-import-github-repo")).toHaveCount(0);
    await expect(onboarding.getByTestId("onboarding-action-start-from-scratch")).toHaveCount(0);
    await expect(onboarding).not.toContainText("Start from scratch");
    await expect(onboarding.locator('button[data-testid^="connect-chip-"]')).toHaveCount(3);
    await expect(onboarding.getByTestId("connect-chip-github")).toBeEnabled();
    await expect(onboarding.getByTestId("connect-chip-notion")).toBeEnabled();
    await expect(onboarding.getByTestId("connect-chip-freefinance")).toBeEnabled();
    await expect(onboarding.getByTestId("onboarding-type-hint")).toHaveText(
      "Or just type what you want below.",
    );

    // The GitHub chip is the same door as the old action card: the import
    // form, with Back returning to the row.
    await onboarding.getByTestId("connect-chip-github").click();
    await expect(page.getByTestId("onboarding-github-repo-input")).toBeVisible();
    await page.getByTestId("onboarding-github-repo-input").fill("openai/openai-openapi");

    await page.getByTestId("onboarding-back-button").click();
    await expect(page.getByTestId("connect-chip-notion")).toBeVisible();

    // The blank path is the composer itself: nothing on the card prefills it
    // or focuses it, the field keeps its own invitation, and send stays
    // disabled until the person types.
    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).not.toContainText("I'm starting from a blank workspace");
    await expect(page.locator("#studio-chat-input")).toHaveAttribute(
      "aria-placeholder",
      "Ask for something…",
    );
    await expect(page.getByText("What do you want to build? One sentence is enough.")).toHaveCount(0);
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    await expect(page.getByTestId("onboarding-getting-started")).not.toHaveAttribute(
      "data-collapsed",
      "true",
    );

    await chatInput.fill("A habit tracker");
    const card = page.getByTestId("onboarding-getting-started");
    await expect(card).toHaveAttribute("data-collapsed", "true");
    await expect(card.getByTestId("onboarding-collapsed-row").getByRole("button")).toHaveText([
      "Import a repo",
      "Notion",
      "More tools",
    ]);
    // First character enables send: empty studio to first message is type, send.
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();

    await chatInput.fill("");
    await expect(card).not.toHaveAttribute("data-collapsed", "true");
    await expect(
      card.getByText("Start with a tool you already use", { exact: true }),
    ).toBeVisible();
  });

  test("github import onboarding shows visible success feedback", async ({ page }) => {
    await page.route("**/projects/*/import/github", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          rev: "mock-rev",
          fileCount: 42,
          targetPath: "repos/openai-openai-openapi",
        }),
      });
    });

    await page.getByTestId("connect-chip-github").click();
    await page.getByTestId("onboarding-github-repo-input").fill("openai/openai-openapi");
    await page.getByTestId("onboarding-github-import-button").click();

    await expect(page.getByTestId("onboarding-getting-started")).toBeHidden();
    await expect(
      page.getByText("Imported 42 files from openai/openai-openapi into repos/openai-openai-openapi.", { exact: false }),
    ).toBeVisible();
  });

  test("repo-link prompt imports directly from chat", async ({ page }) => {
    await page.route("**/projects/*/import/github", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          rev: "mock-rev",
          fileCount: 42,
          targetPath: "repos/openai-openai-openapi",
        }),
      });
    });

    const prompt =
      "Hey I want to continue to work on my project https://github.com/openai/openai-openapi";
    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect(page.locator('[data-testid="chat-bubble-user"]').last()).toContainText(prompt);
    await expect(
      page.getByText(
        "Imported 42 files from openai/openai-openapi into repos/openai-openai-openapi.",
        { exact: false },
      ),
    ).toBeVisible();
  });

  test("repo-link prompt falls back to GitHub connect when access is missing", async ({ page }) => {
    await page.route("**/projects/*/import/github", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "text/plain",
        body: "GitHub repo or ref not found. If this is a private repo, connect GitHub and try again.",
      });
    });

    const prompt =
      "Continue working on my project https://github.com/instafy-dev/test-private-repo";
    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect(page.locator('[data-testid="chat-bubble-user"]').last()).toContainText(prompt);
    await expect(page.getByTestId("integration-request-card")).toContainText("GitHub");
    await expect(page.getByTestId("integration-request-connect-github")).toBeVisible();

    // A deterministic import action must never leak into the composer as a
    // ghost reply that dispatches an unrelated agent run when Send is pressed.
    const userMessages = page.locator('[data-testid="chat-bubble-user"]');
    await expect(userMessages).toHaveCount(1);
    await expect(page.getByText("Import the repo now.", { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => {
        const sendButtons = page.getByTestId("chat-send-button");
        if ((await sendButtons.count()) === 0) {
          return "unavailable";
        }
        return (await sendButtons.first().isDisabled()) ? "unavailable" : "enabled";
      })
      .toBe("unavailable");
    await expect(userMessages).toHaveCount(1);
  });
});

test.describe("Chat onboarding on phones", () => {
  test.use({ viewport: { width: 375, height: 1000 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await installConnectedAiCredentialRoutes(page);
    await prepareStudio(page, { waitForHostedRuntime: false });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-onboarding-phone:cleanup" }).catch(() => {});
  });

  test("keeps the first screen compact with the workspace step in view", async ({ page }) => {
    const onboarding = page.getByTestId("onboarding-getting-started");
    const workspaceStep = onboarding.getByTestId("onboarding-workspace-step");

    await expect(onboarding).toBeVisible();
    await expect(workspaceStep).toBeInViewport();
    await expect(onboarding.getByTestId("connect-chip-github")).toBeInViewport();
    await expect(onboarding.getByTestId("connect-chip-notion")).toBeInViewport();
    await expect(onboarding.getByTestId("connect-chip-freefinance")).toBeInViewport();
    await expect(onboarding.getByTestId("onboarding-type-hint")).toBeInViewport();
    await expect(onboarding.getByTestId("onboarding-path-finance")).toHaveCount(0);

    await expect
      .poll(async () => page.getByTestId("chat-message-scroll").evaluate((element) => element.scrollTop))
      .toBe(0);

    await page.setViewportSize({ width: 375, height: 500 });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    expect(await page.getByTestId("chat-message-scroll").evaluate((element) => element.scrollTop)).toBe(0);

    const compactGeometry = await page.getByTestId("chat-message-scroll").evaluate((scrollElement) => {
      const onboardingElement = scrollElement.querySelector<HTMLElement>(
        '[data-testid="onboarding-getting-started"]',
      );
      if (!onboardingElement) {
        return null;
      }
      const scrollRect = scrollElement.getBoundingClientRect();
      const onboardingRect = onboardingElement.getBoundingClientRect();
      return {
        onboardingTop: onboardingRect.top,
        onboardingWidth: onboardingRect.width,
        scrollViewportTop: scrollRect.top,
        scrollWidth: scrollElement.scrollWidth,
        clientWidth: scrollElement.clientWidth,
      };
    });

    expect(compactGeometry).not.toBeNull();
    expect(compactGeometry!.onboardingTop).toBeGreaterThanOrEqual(compactGeometry!.scrollViewportTop - 1);
    expect(compactGeometry!.onboardingWidth).toBeGreaterThanOrEqual(330);
    expect(compactGeometry!.scrollWidth).toBeLessThanOrEqual(compactGeometry!.clientWidth + 1);

    await page.setViewportSize({ width: 812, height: 375 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-right", "47px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "21px");
      document.documentElement.style.setProperty("--safe-area-inset-left", "47px");
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(
      onboarding.getByText("Start with a tool you already use", { exact: true }),
    ).toBeInViewport();
    expect(await page.getByTestId("chat-message-scroll").evaluate((element) => element.scrollTop)).toBe(0);

    await page.getByTestId("connect-chip-github").click();
    await expect(page.getByTestId("onboarding-back-button")).toBeInViewport();
    await expect
      .poll(async () => page.getByTestId("chat-message-scroll").evaluate((element) => element.scrollTop))
      .toBe(0);
  });
});
