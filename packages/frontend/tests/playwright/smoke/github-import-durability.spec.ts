import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deriveGithubImportTargetPath } from "../../../src/services/runtimeController/githubImportPath.js";
import {
  assertGitRemoteFileText,
  captureAuthenticatedSession,
  getControllerUrl,
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  loginAsGuest,
  listWorkspaceEntries,
  prepareStudio,
  readWorkspaceFileText,
  resetRuntimeUserState,
} from "../utils/harness.js";

const WORKSPACE_BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

// A newly opened Studio project bootstraps managed project-memory files in the
// background. That short mutation owns the same workspace lease as an import,
// whose explicit workspace_busy response is safe to retry with this stable key.
async function postGithubImportWithWorkspaceBusyRetry(params: {
  page: Page;
  url: string;
  accessToken: string;
  data: {
    repo: string;
    targetPath: string;
    idempotencyKey: string;
    githubToken?: string;
  };
}): Promise<APIResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await params.page.context().request.post(params.url, {
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      data: params.data,
    });
    if (response.ok()) {
      return response;
    }

    const errorPayload = (await response.json().catch(() => null)) as
      | { code?: string; details?: { retryable?: boolean } }
      | null;
    const retryableWorkspaceBusy =
      response.status() === 409 &&
      errorPayload?.code === "workspace_busy" &&
      errorPayload.details?.retryable === true;
    const retryDelayMs = WORKSPACE_BUSY_RETRY_DELAYS_MS[attempt];
    if (!retryableWorkspaceBusy || retryDelayMs === undefined) {
      return response;
    }

    await params.page.waitForTimeout(retryDelayMs);
  }
}

test.describe("GitHub import durability", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1).",
  );

  test.describe.configure({ timeout: 240_000 });

  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await loginAsGuest(page);
    activeProjectId = await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "github-import-durability:cleanup" }).catch(() => {});
  });

  test("imports a public repo and persists it to canonical git", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for GitHub import durability test.");
    }

    const session = await captureAuthenticatedSession(page);
    const accessToken = session?.accessToken?.trim() ?? "";
    if (!accessToken) {
      throw new Error("Authenticated session missing access token for GitHub import.");
    }

    const controllerUrl = getControllerUrl();
    const targetPath = deriveGithubImportTargetPath("octocat/Hello-World");
    const idempotencyKey = `github-import-durability:${randomUUID()}`;
    const importStartedAt = Date.now();
    const importUrl = `${controllerUrl}/projects/${encodeURIComponent(activeProjectId)}/import/github`;
    const importResponse = await postGithubImportWithWorkspaceBusyRetry({
      page,
      url: importUrl,
      accessToken,
      data: {
        repo: "octocat/Hello-World",
        targetPath,
        idempotencyKey,
      },
    });

    if (!importResponse.ok()) {
      const detail = await importResponse.text().catch(() => "");
      throw new Error(`GitHub import failed (${importResponse.status()}): ${detail}`);
    }
    const importPayload = (await importResponse.json().catch(() => null)) as
      | {
          ok?: boolean;
          targetPath?: string | null;
          fileCount?: number | null;
          rev?: string | null;
        }
      | null;
    expect(importPayload?.ok).toBeTruthy();

    expect(importPayload?.targetPath?.trim()).toBe(targetPath);

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
        { timeout: 120_000 },
      )
      .not.toBe("");

    const firstFileVisibleMs = Date.now() - importStartedAt;
    test.info().annotations.push({
      type: "metric:first-file-visible-ms",
      description: String(firstFileVisibleMs),
    });

    let importedFileText = "";
    await expect
      .poll(
        async () => {
          importedFileText =
            (await readWorkspaceFileText(page, importedFilePath, { projectId: activeProjectId }))?.trim() ?? "";
          return importedFileText.length > 0;
        },
        { timeout: 120_000 },
      )
      .toBeTruthy();

    await assertGitRemoteFileText(page, importedFilePath, {
      projectId: activeProjectId,
      expectedText: importedFileText,
      requireGitRemote: true,
    });

    // Simulate the controller losing its post-apply checkpoint/response after
    // origin durably completed the write. The same request must recover from
    // POST /apply/status before touching GitHub; an intentionally invalid
    // token makes an accidental re-download fail this assertion.
    const supabaseUrl = getSupabaseUrl().replace(/\/+$/, "");
    const resetOperation = await page.context().request.patch(
      `${supabaseUrl}/rest/v1/github_import_operations?project_id=eq.${encodeURIComponent(
        activeProjectId,
      )}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`,
      {
        headers: {
          ...getSupabaseAuthHeaders(),
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        data: {
          status: "failed",
          applied_json: null,
          response_json: null,
          error_message: "simulated lost controller checkpoint",
          claim_expires_at: new Date(0).toISOString(),
          completed_at: new Date().toISOString(),
        },
      },
    );
    if (!resetOperation.ok()) {
      throw new Error(
        `Failed to reset GitHub import operation (${resetOperation.status()}): ${await resetOperation.text()}`,
      );
    }

    const recoveredResponse = await postGithubImportWithWorkspaceBusyRetry({
      page,
      url: importUrl,
      accessToken,
      data: {
        repo: "octocat/Hello-World",
        targetPath,
        idempotencyKey,
        githubToken: "intentionally-invalid-token-for-receipt-recovery",
      },
    });
    if (!recoveredResponse.ok()) {
      throw new Error(
        `GitHub receipt recovery failed (${recoveredResponse.status()}): ${await recoveredResponse.text()}`,
      );
    }
    const recoveredPayload = (await recoveredResponse.json()) as {
      ok?: boolean;
      rev?: string | null;
      fileCount?: number | null;
    };
    expect(recoveredPayload.ok).toBeTruthy();
    expect(recoveredPayload.rev).toBeTruthy();
    expect(recoveredPayload.fileCount).toBe(importPayload?.fileCount);

    const canonicalDurableMs = Date.now() - importStartedAt;
    test.info().annotations.push({
      type: "metric:canonical-durable-ms",
      description: String(canonicalDurableMs),
    });

    console.info(
      `[github-import-durability] first-file-visible=${firstFileVisibleMs}ms canonical-durable=${canonicalDurableMs}ms file=${importedFilePath}`,
    );
  });

  test("imports a public repo from a chat repo-link prompt and persists it to canonical git", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for GitHub chat import durability test.");
    }

    const repo = "octocat/Hello-World";
    const targetPath = deriveGithubImportTargetPath(repo);
    const importStartedAt = Date.now();
    const prompt = `Continue working on my project https://github.com/${repo}`;

    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect(page.locator('[data-testid="chat-bubble-user"]').last()).toContainText(prompt);
    await expect(
      page.getByText(`Imported`, { exact: false }).filter({ hasText: repo }),
    ).toBeVisible({ timeout: 120_000 });

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
        { timeout: 120_000 },
      )
      .not.toBe("");

    const firstFileVisibleMs = Date.now() - importStartedAt;
    test.info().annotations.push({
      type: "metric:chat-first-file-visible-ms",
      description: String(firstFileVisibleMs),
    });

    let importedFileText = "";
    await expect
      .poll(
        async () => {
          importedFileText =
            (await readWorkspaceFileText(page, importedFilePath, { projectId: activeProjectId }))?.trim() ?? "";
          return importedFileText.length > 0;
        },
        { timeout: 120_000 },
      )
      .toBeTruthy();

    await assertGitRemoteFileText(page, importedFilePath, {
      projectId: activeProjectId,
      expectedText: importedFileText,
      requireGitRemote: true,
    });
    const canonicalDurableMs = Date.now() - importStartedAt;
    test.info().annotations.push({
      type: "metric:chat-canonical-durable-ms",
      description: String(canonicalDurableMs),
    });

    console.info(
      `[github-import-durability] chat-first-file-visible=${firstFileVisibleMs}ms chat-canonical-durable=${canonicalDurableMs}ms file=${importedFilePath}`,
    );
  });
});
