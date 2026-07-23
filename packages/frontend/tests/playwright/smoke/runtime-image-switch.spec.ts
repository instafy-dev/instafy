import { expect, test } from "@playwright/test";

import {
  ensureWorkspacePathsAbsent,
  prepareStudio,
  readWorkspaceFileBytes,
  resetRuntimeUserState,
} from "../utils/harness";

test.describe.skip("runtime image switching", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.describe.configure({ timeout: 600_000 });
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    activeProjectId = await prepareStudio(page);
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "runtime-image-switch:cleanup" }).catch(() => {});
  });

  test("switches to webdev for screenshot prompt", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing for runtime image switch test.");
    }

    await ensureWorkspacePathsAbsent(page, ["artifacts/screenshots/example.com.png"], {
      projectId: activeProjectId,
    });

    const prompt = "Can you go to https://example.com and screenshot the page?";
    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
    const switchBubble = assistantBubbles
      .filter({ hasText: /switching to (the )?web\s*-?\s*dev runtime/i })
      .first();
    try {
      await expect(switchBubble).toBeVisible({ timeout: 30_000 });
      await expect(switchBubble).toHaveAttribute("data-message-type", "runtime_switch");
    } catch (error) {
      const lastBubble = assistantBubbles.last();
      const messageType = await lastBubble.getAttribute("data-message-type").catch(() => null);
      if (messageType === "error") {
        const text = await lastBubble.innerText().catch(() => "");
        const lowered = text.toLowerCase();
        const rateLimited =
          lowered.includes("usage_limit_reached") ||
          lowered.includes("too many requests") ||
          lowered.includes("rate limit") ||
          lowered.includes("upstream 429") ||
          lowered.includes("429");
        if (rateLimited) {
          const snippet = text.replace(/\s+/g, " ").slice(0, 240);
          test.skip(true, `Codex backend rate-limited; skipping runtime switch assertion. (${snippet})`);
        }
      }
      throw error;
    }

    await expect(assistantBubbles.last()).toContainText(/saved screenshot/i, {
      timeout: 540_000,
    });

    let bytes: Buffer | null = null;
    await expect
      .poll(
        async () => {
          bytes = await readWorkspaceFileBytes(page, "artifacts/screenshots/example.com.png", {
            projectId: activeProjectId,
          });
          return bytes?.length ?? 0;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(8);
    expect(bytes?.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
