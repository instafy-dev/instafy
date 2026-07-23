import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe("Project not found", () => {
  test.setTimeout(120_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-not-found:cleanup" }).catch(() => {});
  });

  test("shows project-not-found guidance with header actions", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    const missingProjectId = randomUUID();
    await page.goto(`/studio?projectId=${missingProjectId}&panel=projects`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByTestId("project-missing-blocker")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("workspace-tabs")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("project-picker-new-project")).toBeVisible();

    await page.getByTestId("project-picker-new-project").click();
    await expect(page.getByTestId("project-picker-new-project-name")).toBeVisible();
    await page.getByTestId("project-picker-create-close").click();
  });

  test("opens and submits a seeded bug report from the missing-space blocker", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    const missingProjectId = randomUUID();
    await page.route("**/bug-reports", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const metadata = payload.metadata as Record<string, unknown> | undefined;
      const build = metadata?.build as Record<string, unknown> | undefined;
      expect(payload.message).toBe("This space should open, but Studio says it is unavailable.");
      expect(payload.details).toBe(
        `This space should open, but Studio says it is unavailable.\n\nRequested project id: ${missingProjectId}`,
      );
      expect(payload.projectId).toBe(missingProjectId);
      expect(Array.isArray(payload.logs)).toBe(true);
      expect(typeof metadata?.location).toBe("string");
      expect(build?.packageVersion).toBe("0.1.0");
      expect(typeof build?.releaseId).toBe("string");
      expect(typeof build?.builtAt).toBe("string");
      expect(typeof build?.gitCommit).toBe("string");
      expect((build?.gitCommit as string).length).toBeGreaterThan(7);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "3d54fa80-8ca9-4a92-a5fe-c2970e302153",
          createdAt: "2026-03-15T10:00:00.000Z",
        }),
      });
    });

    await page.goto(`/studio?projectId=${missingProjectId}&panel=projects`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByTestId("project-missing-blocker")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("project-missing-report-bug").click();
    await expect(page.getByTestId("bug-report-modal")).toBeVisible();
    await expect(page.getByTestId("bug-report-description")).toHaveValue(
      `This space should open, but Studio says it is unavailable.\n\nRequested project id: ${missingProjectId}`,
    );
    await page.getByTestId("bug-report-submit").click();
    await expect(page.getByTestId("bug-report-modal")).toBeHidden({ timeout: 10_000 });
  });
});
