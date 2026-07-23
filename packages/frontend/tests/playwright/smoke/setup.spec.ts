import { expect, test } from "@playwright/test";
import {
  captureAuthenticatedSession,
  prepareStudio,
  clearRuntimePreference,
  gotoStudio,
  requestHostedRuntime,
  restoreAuthenticatedSession,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(projectId: string, page: Parameters<typeof waitForHostedRuntimeReady>[0]) {
  const ready = await waitForHostedRuntimeReady(page, 10_000)
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

test.describe.serial("setup", () => {
  test.setTimeout(180_000);
  let sharedProjectId: string | null = null;
  let sharedRuntimeId: string | null = null;
  let sharedAuthSession: Awaited<ReturnType<typeof captureAuthenticatedSession>> = null;

  test("hosted", async ({ page }) => {
    page.setDefaultTimeout(90_000);
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Failed to create project for hosted runtime setup test.");
    }
    await clearRuntimePreference(page, { projectId, source: "smoke" });
    await ensureHostedRuntimeReady(projectId, page);
    const runtime = await waitForHostedRuntimeReady(page, 30_000);
    expect(runtime.health).toBe("online");

    sharedProjectId = projectId;
    sharedRuntimeId = runtime.runtimeId;
    sharedAuthSession = await captureAuthenticatedSession(page);
  });

  test("reload-hosted", async ({ page }) => {
    page.setDefaultTimeout(90_000);
    if (!sharedProjectId || !sharedRuntimeId || !sharedAuthSession) {
      throw new Error("Shared hosted runtime setup missing from previous test.");
    }

    await restoreAuthenticatedSession(page, sharedAuthSession);
    await gotoStudio(page, { projectId: sharedProjectId });
    await clearRuntimePreference(page, { projectId: sharedProjectId, source: "smoke" });
    await ensureHostedRuntimeReady(sharedProjectId, page);
    const runtime = await waitForHostedRuntimeReady(page, 30_000);
    expect(runtime.health).toBe("online");
    expect(runtime.runtimeId).toBe(sharedRuntimeId);

    await page.reload();
    const hostedAfterReload = await waitForHostedRuntimeReady(page, 60_000);
    expect(runtime.runtimeId).toBe(hostedAfterReload.runtimeId);
  });
});
