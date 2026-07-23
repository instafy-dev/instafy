import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe("Project restore", () => {
  test.setTimeout(120_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-restore:cleanup" }).catch(() => {});
  });

  test("recovers from stale stored projectId", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    const missingProjectId = randomUUID();
    await page.evaluate((id) => {
      window.localStorage.setItem("instafy.lastProjectId", id);
    }, missingProjectId);

    await page.goto("/studio", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("workspace-tabs")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("project-missing-blocker")).toHaveCount(0);

    const url = new URL(page.url());
    const restoredProjectId = url.searchParams.get("projectId");
    expect(restoredProjectId).toBeTruthy();
    expect(restoredProjectId).not.toEqual(missingProjectId);
  });
});

