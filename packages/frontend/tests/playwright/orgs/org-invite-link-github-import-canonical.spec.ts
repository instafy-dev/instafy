import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deriveGithubImportTargetPath } from "../../../src/services/runtimeController/githubImportPath.js";
import {
  assertGitRemoteFileText,
  getControllerUrl,
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  loginAsGuest,
  prepareStudio,
  readWorkspaceFileText,
  listWorkspaceEntries,
  requestHostedRuntime,
  teardownPlaywrightProject,
  waitForHostedRuntimeReady,
  waitForStoreProjectId,
} from "../utils/harness.js";

// The controller import request contains the purpose-scoped GitHub fixture
// credential. Never serialize it into a retained Playwright trace artifact.
test.use({ trace: "off" });

const WORKSPACE_BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

type InstafyE2EBridge = {
  createBlankConversation?: (input: {
    projectId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<string | null>;
};

type InstafyE2EWindow = Window & {
  __INSTAFY_E2E__?: InstafyE2EBridge;
};

type BrowserSupabaseClient = {
  auth?: {
    getSession?: () => Promise<{ data?: { session?: { access_token?: string | null } | null } | null }>;
  };
};

type InstafyBrowserWindow = Window & {
  __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
};

function conversationTabButtons(page: Page) {
  return page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
}

async function resolveActiveConversationLocalId(page: Page): Promise<string> {
  const tabs = conversationTabButtons(page);
  await expect(tabs).toHaveCount(1);
  const tabId = await tabs.first().getAttribute("data-tab-id");
  if (!tabId) {
    throw new Error("Conversation tab missing data-tab-id.");
  }
  return tabId.startsWith("workspace-conversation-")
    ? tabId.replace("workspace-conversation-", "")
    : tabId;
}

async function createBlankControllerConversationId(params: {
  page: Page;
  projectId: string;
  localConversationId: string;
}): Promise<string> {
  const conversationId = await params.page.evaluate(
    async ({ projectId, localConversationId }) => {
      const e2e = (window as InstafyE2EWindow).__INSTAFY_E2E__;
      if (!e2e?.createBlankConversation) {
        return null;
      }
      return await e2e.createBlankConversation({
        projectId,
        metadata: { localId: localConversationId },
      });
    },
    { projectId: params.projectId, localConversationId: params.localConversationId },
  );

  const normalized = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!normalized) {
    throw new Error("Unable to create blank controller conversation (missing conversationId).");
  }
  return normalized;
}

async function getSupabaseAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const client = (window as InstafyBrowserWindow).__INSTAFY_SUPABASE__;
    const result = await client?.auth?.getSession?.();
    return result?.data?.session?.access_token ?? null;
  });
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Unable to resolve Supabase access token.");
  }
  return token.trim();
}

async function importGithubRepoViaController(params: {
  page: Page;
  projectId: string;
  repo: string;
  targetPath: string;
}): Promise<{ fileCount: number | null; targetPath: string | null }> {
  const accessToken = await getSupabaseAccessToken(params.page);
  const importUrl = `${getControllerUrl()}/projects/${encodeURIComponent(params.projectId)}/import/github`;
  const idempotencyKey = `org-invite-link-github-import:${randomUUID()}`;
  const githubToken =
    process.env.GITHUB_CANONICAL_IMPORT_TOKEN?.trim() ||
    process.env.GH_TESTING_TOKEN?.trim() ||
    undefined;
  let response: APIResponse;
  for (let attempt = 0; ; attempt += 1) {
    response = await params.page.context().request.post(importUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      data: {
        repo: params.repo,
        targetPath: params.targetPath,
        idempotencyKey,
        ...(githubToken ? { githubToken } : {}),
      },
      timeout: 120_000,
    });
    if (response.ok()) {
      break;
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
      throw new Error(
        `GitHub import failed (${response.status()}): ${JSON.stringify(errorPayload)?.slice(0, 500)}`,
      );
    }
    await params.page.waitForTimeout(retryDelayMs);
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    fileCount?: number | null;
    targetPath?: string | null;
  } | null;
  if (!payload?.ok) {
    throw new Error(`GitHub import response missing ok: ${JSON.stringify(payload)}`);
  }
  return {
    fileCount: typeof payload.fileCount === "number" ? payload.fileCount : null,
    targetPath:
      typeof payload.targetPath === "string" && payload.targetPath.trim().length > 0
        ? payload.targetPath.trim()
        : null,
  };
}

async function seedControllerConversationMessage(page: Page, input: {
  projectId: string;
  conversationId: string;
  role: "assistant" | "user";
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const supabaseUrl = getSupabaseUrl().replace(/\/+$/, "");
  const headers = getSupabaseAuthHeaders();
  const serviceRole = headers.authorization ?? "";
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Supabase service role missing; cannot seed conversation messages.");
  }

  const response = await page.context().request.post(`${supabaseUrl}/rest/v1/conversation_messages`, {
    headers: {
      ...headers,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    data: {
      id: randomUUID(),
      conversation_id: input.conversationId,
      project_id: input.projectId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
    },
  });

  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to seed controller conversation message (${response.status()}): ${body.slice(0, 200)}`,
    );
  }
}

async function openProjectSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000, { projectId });
}

async function createProjectInviteLink(page: Page): Promise<string> {
  await openProjectSettings(page);
  await page.getByTestId("org-invite-link-role").selectOption("builder");
  await page.getByTestId("org-invite-link-create").click();
  const inviteLinkInput = page.getByTestId("org-invite-link-url");
  await expect(inviteLinkInput).toBeVisible();
  const inviteLinkUrl = await inviteLinkInput.inputValue();
  if (!inviteLinkUrl) {
    throw new Error("Invite link URL missing.");
  }
  return inviteLinkUrl;
}

async function openSharedConversation(page: Page, params: {
  projectId: string;
  conversationControllerId: string;
}) {
  await page.goto(
    `/studio?projectId=${encodeURIComponent(params.projectId)}&panel=chat&conversationControllerId=${encodeURIComponent(
      params.conversationControllerId,
    )}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForURL(
    (url) =>
      url.pathname.includes("/studio") &&
      url.searchParams.get("projectId") === params.projectId &&
      url.searchParams.get("conversationControllerId") === params.conversationControllerId,
    { timeout: 60_000 },
  );
}

function sanitizeFileEntryTestId(path: string): string {
  return `files-entry-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

async function openWorkspaceFile(page: Page, filePath: string) {
  // Keep the mounted Studio document alive. Starting a hosted runtime changes
  // Docker networking locally, so a full Vite reload here can strand the app
  // with an empty root after module requests fail with ERR_NETWORK_CHANGED.
  // Selecting a file from the normal explorer opens and activates its file tab.
  await page.getByTestId("sidebar-nav-code").click();
  const refreshButton = page.getByTestId("files-explorer-refresh");
  await expect(refreshButton).toBeEnabled({ timeout: 30_000 });
  await refreshButton.click();
  await page.getByTestId("code-search-input").fill("");

  const segments = filePath.split("/").filter((segment) => segment.length > 0);
  let currentPath = "";
  for (const segment of segments.slice(0, -1)) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const directoryEntry = page.getByTestId(sanitizeFileEntryTestId(currentPath));
    await expect(directoryEntry).toBeVisible({ timeout: 60_000 });
    const expanded = await directoryEntry.getAttribute("aria-expanded");
    if (expanded !== "true") {
      await directoryEntry.click();
    }
  }

  const fileEntry = page.getByTestId(sanitizeFileEntryTestId(filePath));
  await expect(fileEntry).toBeVisible({ timeout: 60_000 });
  await fileEntry.click();
  await expect(page.getByTestId("monaco-editor")).toBeVisible({ timeout: 60_000 });
}

test.describe("Org invite link GitHub import durability", () => {
  let createdProjectId: string | null = null;

  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1).",
  );

  test.describe.configure({ timeout: 240_000, retries: 1 });

  test.afterEach(async ({ page }) => {
    if (!createdProjectId) {
      return;
    }
    await teardownPlaywrightProject(page, createdProjectId, {
      source: "org-invite-link-github-import-canonical:cleanup",
    }).catch(() => {});
    createdProjectId = null;
  });

  test("GitHub import propagates to a second user and persists to canonical git", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for multi-user GitHub import durability test.");
    }
    createdProjectId = projectId;

    await page.getByTestId("sidebar-nav-chat").click();
    const localConversationId = await resolveActiveConversationLocalId(page);
    const sharedConversationControllerId = await createBlankControllerConversationId({
      page,
      projectId,
      localConversationId,
    });
    await openSharedConversation(page, {
      projectId,
      conversationControllerId: sharedConversationControllerId,
    });

    const inviteLink = new URL(await createProjectInviteLink(page));
    inviteLink.searchParams.set("conversationControllerId", sharedConversationControllerId);
    inviteLink.searchParams.set("panel", "chat");
    const inviteLinkUrl = inviteLink.toString();
    await page.getByTestId("sidebar-nav-chat").click();

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    try {
      memberPage.setDefaultTimeout(60_000);
      await loginAsGuest(memberPage);
      await memberPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
      await memberPage.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });
      await memberPage
        .getByText("Preparing your studio workspace…", { exact: false })
        .waitFor({ state: "detached", timeout: 60_000 })
        .catch(() => {});
      await expect
        .poll(async () => await waitForStoreProjectId(memberPage, projectId, 20_000))
        .toBeTruthy();
      await openSharedConversation(memberPage, {
        projectId,
        conversationControllerId: sharedConversationControllerId,
      });

      const repo = "octocat/Hello-World";
      const targetPath = deriveGithubImportTargetPath(repo);

      const importStartedAt = Date.now();
      const importResult = await importGithubRepoViaController({
        page,
        projectId,
        repo,
        targetPath,
      });
      const importedTargetPath = importResult.targetPath ?? targetPath;
      const fileCountLabel =
        typeof importResult.fileCount === "number"
          ? `${importResult.fileCount} ${importResult.fileCount === 1 ? "file" : "files"}`
          : "your files";
      await seedControllerConversationMessage(page, {
        projectId,
        conversationId: sharedConversationControllerId,
        role: "assistant",
        content: `Imported ${fileCountLabel} from ${repo} into \`${importedTargetPath}\`. You can ask me to investigate issues, map the architecture, or start a concrete improvement now.`,
        metadata: {
          agent: { handle: "octo" },
          githubImport: {
            projectId,
            repo,
            ref: null,
            targetPath: importedTargetPath,
            fileCount: importResult.fileCount,
          },
        },
      });
      await openSharedConversation(page, {
        projectId,
        conversationControllerId: sharedConversationControllerId,
      });
      await openSharedConversation(memberPage, {
        projectId,
        conversationControllerId: sharedConversationControllerId,
      });

      const successPattern = new RegExp(`Imported .*${repo.replace("/", "\\/")}`, "i");
      await expect(page.getByText(successPattern)).toBeVisible({ timeout: 120_000 });
      await expect(memberPage.getByText(successPattern)).toBeVisible({ timeout: 120_000 });

      const conversationVisibleMs = Date.now() - importStartedAt;
      test.info().annotations.push({
        type: "metric:second-user-conversation-visible-ms",
        description: String(conversationVisibleMs),
      });

      let importedFilePath = "";
      await expect
        .poll(
          async () => {
            const entries = await listWorkspaceEntries(page, importedTargetPath, { projectId });
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

      let importedFileText = "";
      await expect
        .poll(
          async () => {
            importedFileText =
              (await readWorkspaceFileText(page, importedFilePath, { projectId }))?.trim() ?? "";
            return importedFileText.length > 0;
          },
          { timeout: 120_000 },
        )
        .toBeTruthy();

      const expectedSnippet =
        importedFileText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0)
          ?.slice(0, 80) ?? importedFileText.slice(0, 80);
      if (!expectedSnippet) {
        throw new Error(`Imported file ${importedFilePath} did not contain readable text.`);
      }

      await ensureHostedRuntimeReady(page, projectId);
      await openWorkspaceFile(memberPage, importedFilePath);
      await expect(memberPage.getByTestId("monaco-editor")).toContainText(expectedSnippet, {
        timeout: 60_000,
      });

      const secondUserFileVisibleMs = Date.now() - importStartedAt;
      test.info().annotations.push({
        type: "metric:second-user-file-visible-ms",
        description: String(secondUserFileVisibleMs),
      });

      await assertGitRemoteFileText(page, importedFilePath, {
        projectId,
        expectedText: importedFileText,
        requireGitRemote: true,
      });
      const canonicalDurableMs = Date.now() - importStartedAt;
      test.info().annotations.push({
        type: "metric:multi-user-canonical-durable-ms",
        description: String(canonicalDurableMs),
      });

      console.info(
        `[org-invite-link-github-import-canonical] conversation-visible=${conversationVisibleMs}ms second-user-file-visible=${secondUserFileVisibleMs}ms canonical-durable=${canonicalDurableMs}ms file=${importedFilePath}`,
      );
    } finally {
      await memberContext.close().catch(() => {});
    }
  });
});
