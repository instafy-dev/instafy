import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";
import { openSecretsPanel } from "../utils/sidebar.js";

test.use({ trace: "off" });

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

async function createProjectSecret(page: Page, params: {
  name: string;
  value: string;
  description: string;
}) {
  const canonicalName = params.name.trim().toUpperCase();
  await openSecretsPanel(page);
  const secretsCard = page.getByTestId("project-secrets-card");
  await expect(secretsCard).toBeVisible();

  await secretsCard.getByTestId("project-secret-create").click();
  await expect(page.getByTestId("project-secret-modal")).toBeVisible();

  await page.getByTestId("project-secret-name-input").fill(params.name);
  await page.getByTestId("project-secret-description-input").fill(params.description);
  await page.getByTestId("project-secret-value-input").fill(params.value);

  const firstAgentCheckbox = page.locator('[data-testid^="project-secret-agent-"]').first();
  if ((await firstAgentCheckbox.count()) > 0) {
    await firstAgentCheckbox.click();
  }

  await page.getByTestId("project-secret-save").click();
  await expect(page.getByTestId("project-secret-modal")).toBeHidden({ timeout: 30_000 });
  await expect(secretsCard).toContainText(canonicalName, { timeout: 30_000 });
}

async function sendChat(page: Page, message: string) {
  await page.getByTestId("chat-input").fill(message);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 90_000 });
  await page.getByTestId("chat-send-button").click();
}

test.describe("Project secrets CLI inventory", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.skip(
    (process.env.PLAYWRIGHT_LIVE_SECRET_INVENTORY ?? "").trim() !== "1",
    "Live assistant secret inventory smoke is model-dependent; opt in with PLAYWRIGHT_LIVE_SECRET_INVENTORY=1.",
  );

  test.describe.configure({ timeout: 360_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-secrets-cli-inventory:cleanup" }).catch(() => {});
  });

  test("assistant can discover custom secret names via instafy secrets list", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for project-secrets-cli-inventory.");
    }
    await clearRuntimePreference(page, { projectId, source: "project-secrets-cli-inventory" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const specialSecretName = "a_very_special_token";
    await createProjectSecret(page, {
      name: specialSecretName,
      value: "value-for-playwright-only",
      description: "Token used to verify CLI secret inventory path.",
    });

    await page.getByTestId("sidebar-nav-chat").click();
    const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
    const baselineAssistantCount = await assistantBubbles.count();

    const prompt = [
      "Run a space secret inventory check.",
      "",
      `Use this exact command first: instafy secrets list --space ${projectId} --json`,
      "Then answer with exactly one line:",
      "SECRET_NAMES: <comma-separated names>",
      "Use only names from that command. Do not guess and do not include descriptions.",
    ].join("\n");
    await sendChat(page, prompt);

    const threadBubble = assistantBubbles.nth(baselineAssistantCount);
    await expect(threadBubble).toBeVisible({ timeout: 240_000 });

    // Wait until the assistant produced the expected response line so the run thread is settled
    // (job id, compact rail, etc.), otherwise the expand toggle can race and become a no-op.
    await expect(threadBubble).toContainText(/SECRET_NAMES:/i, { timeout: 240_000 });

    // The thread preview can compact to an icon rail after completion; expand so command output
    // is visible and we can assert the CLI was actually invoked.
    const expandRunUpdates = threadBubble.getByRole("button", { name: /expand run updates/i });
    if ((await expandRunUpdates.count()) > 0) {
      await expect(expandRunUpdates).toBeVisible({ timeout: 30_000 });
      await expandRunUpdates.click();
    }

    await expect
      .poll(
        async () => {
          const outputTexts = await threadBubble
            .getByTestId("chat-command-output")
            .allInnerTexts()
            .catch(() => []);
          const threadTexts = await threadBubble
            .getByTestId("agent-job-thread-preview")
            .allInnerTexts()
            .catch(() => []);
          return [...outputTexts, ...threadTexts].join("\n").toLowerCase();
        },
        { timeout: 240_000 },
      )
      .toContain("instafy secrets list");

    await expect
      .poll(
        async () => {
          const texts = await assistantBubbles.allInnerTexts();
          return texts.join("\n");
        },
        { timeout: 240_000 },
      )
      .toMatch(/SECRET_NAMES:[\s\S]*a_very_special_token/i);
  });
});
