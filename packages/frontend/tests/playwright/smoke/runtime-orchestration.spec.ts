import { test, expect, type Page } from "@playwright/test";
import {
  prepareStudio,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  requireWorkspaceProjectId,
  gotoStudio,
} from "../utils/harness.js";


let activeProjectId: string | null = null;

function requireActiveProjectId(): string {
  if (!activeProjectId) {
    throw new Error("Active project id is unavailable in runtime orchestration tests.");
  }
  return activeProjectId;
}

async function openStudio(page: Page) {
  const projectId = requireActiveProjectId();
  await gotoStudio(page, { projectId });
}

test.describe.serial("Runtime orchestration - hosted onboarding", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    activeProjectId = await prepareStudio(page);
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "runtime-orchestration:onboarding-cleanup" });
  });

  test("reuse runtime after reload", async ({ page }) => {
    const projectId = requireActiveProjectId();
    // wait for hosted runtime to be ready
    const hosted = await waitForHostedRuntimeReady(page, 120_000, { projectId });
    await page.reload();
    const hostedAfterReload = await waitForHostedRuntimeReady(page, 120_000, { projectId });
    expect(hosted.runtimeId).toBe(hostedAfterReload.runtimeId);
  });

  test("new users wait for hosted runtime without seeing fallback dialog", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(60_000);
    const projectId = requireActiveProjectId();

    await openStudio(page);

    const fallbackDialog = page.getByTestId("runtime-fallback-dialog");
    const sendButton = page.getByTestId("chat-send-button");
    const runtimeSelectorButton = page.getByTestId("runtime-selector-button").first();

    await expect(runtimeSelectorButton).toBeVisible({ timeout: 15_000 });

    // Ensure the fallback dialog stays hidden while the hosted runtime is requested.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(fallbackDialog).toBeHidden({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
    }

    await waitForHostedRuntimeReady(page, 120_000, { projectId });
    await page.getByTestId("chat-input").fill(`Hosted runtime ready check ${Date.now()}`);
    await expect(sendButton).toBeEnabled({ timeout: 180_000 });
    await expect(fallbackDialog).toBeHidden();
  });
});

// Hosted fallback coverage

test.describe.serial("Runtime orchestration - fallback dialog", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    activeProjectId = await prepareStudio(page);
  });

  test.afterEach(async ({ page }) => {
    try {
      const projectId = await requireWorkspaceProjectId(page);
      await clearRuntimePreference(page, {
        projectId,
        source: "runtime-orchestration:fallback-reset"
      });
    } catch {
      // ignore cleanup failures
    }
  });

});
