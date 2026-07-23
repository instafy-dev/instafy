import fs from "node:fs";

import { expect, test } from "@playwright/test";

import { deriveGithubImportTargetPath } from "../../../src/services/runtimeController/githubImportPath.js";
import {
  assertGitRemoteFileText,
  listWorkspaceEntries,
  prepareStudio,
  readWorkspaceFileText,
  teardownPlaywrightProject,
} from "../utils/harness.js";

type OnboardingBenchResult = {
  repo: string;
  projectId: string;
  targetPath: string;
  importedFilePath: string;
  prompt: string;
  startedAt: string;
  completedAt: string;
  promptToImportCompleteMs: number;
  promptToFirstFileVisibleMs: number;
  promptToCanonicalDurableMs: number;
};

function resolveBenchRepo(): string {
  return (process.env.PLAYWRIGHT_ONBOARDING_BENCH_REPO ?? "astral-sh/uv").trim() || "astral-sh/uv";
}

function resolveBenchTimeoutMs(): number {
  const raw = (process.env.PLAYWRIGHT_ONBOARDING_BENCH_TIMEOUT_MS ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 15 * 60_000;
}

test.describe("GitHub onboarding bench", () => {
  let activeProjectId: string | null = null;

  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1).",
  );

  test.describe.configure({ timeout: resolveBenchTimeoutMs() });

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(90_000);
    activeProjectId = await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    if (!activeProjectId) {
      return;
    }
    await teardownPlaywrightProject(page, activeProjectId, {
      source: "bench:github-import-chat:cleanup",
    }).catch(() => {});
    activeProjectId = null;
  });

  test("imports a public repo from chat and records standardized onboarding timings", async ({
    page,
  }, testInfo) => {
    if (!activeProjectId) {
      throw new Error("Project id missing for GitHub onboarding bench.");
    }

    const repo = resolveBenchRepo();
    const targetPath = deriveGithubImportTargetPath(repo);
    const prompt = `I want to continue to work on my project https://github.com/${repo}`;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect(page.locator('[data-testid="chat-bubble-user"]').last()).toContainText(prompt);

    const successPattern = new RegExp(`Imported .*${repo.replace("/", "\\/")}`, "i");
    await expect(page.getByText(successPattern)).toBeVisible({ timeout: 600_000 });
    const promptToImportCompleteMs = Date.now() - startedAtMs;

    let importedFilePath = "";
    await expect
      .poll(
        async () => {
          const entries = await listWorkspaceEntries(page, targetPath, { projectId: activeProjectId });
          const fileEntry =
            entries?.find((entry) => entry.kind === "file") ??
            entries?.find((entry) => (entry.kind ?? "").toLowerCase() !== "directory") ??
            null;
          importedFilePath = typeof fileEntry?.path === "string" ? fileEntry.path.trim() : "";
          return importedFilePath;
        },
        { timeout: 600_000 },
      )
      .not.toBe("");
    const promptToFirstFileVisibleMs = Date.now() - startedAtMs;

    let importedFileText = "";
    await expect
      .poll(
        async () => {
          importedFileText =
            (await readWorkspaceFileText(page, importedFilePath, { projectId: activeProjectId }))?.trim() ?? "";
          return importedFileText.length > 0;
        },
        { timeout: 600_000 },
      )
      .toBeTruthy();

    await assertGitRemoteFileText(page, importedFilePath, {
      projectId: activeProjectId,
      expectedText: importedFileText,
      requireGitRemote: true,
      timeoutMs: 600_000,
    });
    const promptToCanonicalDurableMs = Date.now() - startedAtMs;
    const completedAt = new Date().toISOString();

    const result: OnboardingBenchResult = {
      repo,
      projectId: activeProjectId,
      targetPath,
      importedFilePath,
      prompt,
      startedAt,
      completedAt,
      promptToImportCompleteMs,
      promptToFirstFileVisibleMs,
      promptToCanonicalDurableMs,
    };

    test.info().annotations.push(
      {
        type: "metric:prompt-to-import-complete-ms",
        description: String(promptToImportCompleteMs),
      },
      {
        type: "metric:prompt-to-first-file-visible-ms",
        description: String(promptToFirstFileVisibleMs),
      },
      {
        type: "metric:prompt-to-canonical-durable-ms",
        description: String(promptToCanonicalDurableMs),
      },
    );

    const artifactPath = testInfo.outputPath("github-import-chat-bench.json");
    fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    console.info(
      `[github-import-chat-bench] repo=${repo} prompt-to-import-complete=${promptToImportCompleteMs}ms prompt-to-first-file-visible=${promptToFirstFileVisibleMs}ms prompt-to-canonical-durable=${promptToCanonicalDurableMs}ms file=${importedFilePath}`,
    );
  });
});
