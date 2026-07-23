import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareStudio,
  clearRuntimePreference,
  requestHostedRuntime,
  waitForHostedRuntimeReady,
  resetRuntimeUserState,
  ensureVisionModelForImagePrompts
} from "../utils/harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");

async function ensureHostedRuntimeReady(projectId: string, page: Page) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

test.describe("Chat image upload", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.skip(
    (process.env.PLAYWRIGHT_LIVE_VISION_CHAT ?? "").trim() !== "1",
    "Live vision chat answer generation is model-dependent; opt in with PLAYWRIGHT_LIVE_VISION_CHAT=1."
  );

  test.setTimeout(240_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-image-upload:cleanup" }).catch(() => {});
  });

  test("uploads an image, previews fullscreen, and answers about it", async ({ page }) => {
    const projectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId, source: "smoke" });
    await ensureHostedRuntimeReady(projectId, page);
    await ensureVisionModelForImagePrompts(page).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      test.skip(
        true,
        `Image chat requires a vision-capable model; unable to switch from default model: ${message}`
      );
    });

    const duckPath = path.join(repoRoot, "packages", "frontend", "public", "duck.jpeg");
    await page.getByTestId("chat-image-upload-input").setInputFiles(duckPath);

    await expect(page.getByTestId("chat-image-upload-preview")).toBeVisible();

    const prompt = "What animal is this? if it is a duck, say \"Quack!\" else say \"Unknown animal.\"";
    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();

    const userBubble = page.locator('[data-testid="chat-bubble-user"]').last();
    await expect(userBubble).toContainText(prompt);

    const thumbnail = page.getByTestId("chat-image-attachment-thumbnail").last();
    await expect(thumbnail).toBeVisible({ timeout: 60_000 });

    await thumbnail.click();
    await expect(page.getByTestId("chat-image-lightbox")).toBeVisible();
    await expect(page.getByTestId("chat-image-lightbox-image")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-image-lightbox")).toHaveCount(0);

    const duckAnswer = page
      .locator('[data-testid="chat-bubble-assistant"]')
      .filter({ hasText: /quack/i })
      .first();
    const waitForQuack = async (timeout: number) => {
      await expect(duckAnswer).toBeVisible({ timeout });
    };
    try {
      await waitForQuack(120_000);
    } catch {
      // If the runtime is still provisioning or the UI missed the SSE updates, re-ensure + reload.
      await requestHostedRuntime(page, { projectId, source: "chat" }).catch(() => {});
      await waitForHostedRuntimeReady(page, 120_000).catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.getByTestId("sidebar-nav-chat").click().catch(() => {});
      await waitForQuack(120_000);
    }
  });
});
