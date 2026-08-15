import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  listWorkspaceEntries,
  prepareStudio,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";

const LEARN_MODEL =
  (process.env.PLAYWRIGHT_LEARN_MODEL ?? process.env.PLAYWRIGHT_RETRO_MODEL ?? "gpt-5.5").trim() ||
  "gpt-5.5";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

function isRetryableLearnUpstreamError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("unexpected status 429") ||
    normalized.includes("unexpected status 500") ||
    normalized.includes("unexpected status 502") ||
    normalized.includes("unexpected status 503") ||
    normalized.includes("unexpected status 504") ||
    normalized.includes("upstream request failed") ||
    normalized.includes("backend responded with 429") ||
    normalized.includes("stream disconnected before completion") ||
    normalized.includes("error sending request for url")
  );
}

async function readLearnSignalText(page: Page): Promise<string> {
  const learnThreadPreview = page
    .getByTestId("conversation-thread-preview")
    .filter({ hasText: /learn/i })
    .first();

  const previewVisible = await learnThreadPreview.isVisible().catch(() => false);
  if (previewVisible) {
    return (await learnThreadPreview.innerText().catch(() => "")).trim();
  }

  return (await page.locator('[data-testid="chat-bubble-assistant"]').last().innerText().catch(() => "")).trim();
}

async function runLearnUntilWorkspaceUpdate(
  page: Page,
  projectId: string,
  prompt: string,
  options: { timeoutMs: number; maxRetries: number; isSuccess: (content: string) => boolean },
): Promise<string> {
  let lastSignal = "";
  let lastContent = "";

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();

    const deadline = Date.now() + options.timeoutMs;
    let shouldRetry = false;
    while (Date.now() < deadline) {
      lastContent = (await readWorkspaceFileText(page, "INSTAFY.md", { projectId }))?.trim() ?? "";
      if (options.isSuccess(lastContent)) {
        return lastContent;
      }

      const signal = await readLearnSignalText(page);
      if (signal) {
        lastSignal = signal;
      }
      if (isRetryableLearnUpstreamError(signal)) {
        shouldRetry = true;
        break;
      }

      await page.waitForTimeout(1_000);
    }

    if (!shouldRetry) {
      break;
    }
  }

  throw new Error(`Timed out waiting for learn workspace update. Last signal: ${lastSignal || "<none>"}`);
}

test.describe("Learn command", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.describe.configure({ timeout: 240_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "learn-command:cleanup" }).catch(() => {});
  });

  test("updates INSTAFY.md via /learn", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for learn test.");
    }
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "learn-command" }).catch(() => {});
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, LEARN_MODEL);

    const learnContent = await runLearnUntilWorkspaceUpdate(page, projectId, "/learn", {
      timeoutMs: 180_000,
      maxRetries: 1,
      isSuccess: (content) => content.includes("# INSTAFY.md"),
    });
    expect(learnContent).toContain("# INSTAFY.md");

    await expect
      .poll(
        async () => {
          const entries = await listWorkspaceEntries(page, ".agents/skills/instafy-learned", { projectId });
          return (entries ?? []).map((entry) => entry.name).join("\n");
        },
        { timeout: 60_000 }
      )
      .toContain("blocks");

    await expect
      .poll(
        async () => {
          return (
            await readWorkspaceFileText(
              page,
              ".agents/skills/instafy-learning-policy/SKILL.md",
              { projectId }
            )
          )?.trim();
        },
        { timeout: 60_000 }
      )
      .toContain("Learning policy");
  });

  test("learn collect remains non-mutating across a new conversation", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for learn test.");
    }
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "learn-command:reply-style" }).catch(() => {});
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, LEARN_MODEL);

    const seededLearnings = [
      "# INSTAFY.md",
      "",
      "## Preferences",
      '- Always start every reply with the exact prefix "AHOY:" (including the colon).',
    ].join("\n");
    await writeWorkspaceFile(page, "INSTAFY.md", `${seededLearnings}\n`, { projectId });

    await createPublicChatFromTopBar(page);
    const collectMessageRecorded = page
      .waitForResponse((response) => {
        if (response.request().method() !== "POST" || !response.ok()) {
          return false;
        }
        const pathname = new URL(response.url()).pathname;
        return /\/projects\/[^/]+\/conversations\/[^/]+\/messages(?:\/record)?$/.test(pathname);
      })
      .catch(() => null);
    await page.getByTestId("chat-input").fill("/learn collect 6");
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();
    await collectMessageRecorded;
    await expect(page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: "/learn collect 6" }).first()).toBeVisible({
      timeout: 30_000,
    });

    let afterCollect = "";
    await expect
      .poll(
        async () => {
          afterCollect = (await readWorkspaceFileText(page, "INSTAFY.md", { projectId }))?.trim() ?? "";
          return afterCollect;
        },
        { timeout: 60_000 }
      )
      .not.toBe("");
    expect(afterCollect).toContain("## Preferences");
    expect(afterCollect).toContain('AHOY:');
  });
});
