import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deriveGithubImportTargetPath } from "../../../src/services/runtimeController/githubImportPath.js";
import {
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  listWorkspaceEntries,
  prepareStudio,
  readWorkspaceFileText,
  resetRuntimeUserState,
} from "../utils/harness.js";

test.use({ trace: "off" });

type InstafyE2EBridge = {
  createBlankConversation?: (input: {
    projectId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<string | null>;
  emitConversationMessage?: (message: Record<string, unknown>) => void;
};

type InstafyE2EWindow = Window & {
  __INSTAFY_E2E__?: InstafyE2EBridge;
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

test.describe("GitHub private repo clone (secrets)", () => {
  test.skip(
    !(process.env.GH_TESTING_TOKEN ?? "").trim(),
    "Missing GH_TESTING_TOKEN. Provide it via .env.github-testing (local) or GitHub Actions secret (CI).",
  );

  test.describe.configure({ timeout: 420_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "github-private-repo-clone:cleanup" }).catch(() => {});
  });

  test("requests GITHUB_TOKEN, clones private repo, and makes hello.md readable", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Active project id missing for GitHub private repo clone test.");
    }

    await page.getByTestId("sidebar-nav-chat").click();

    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              Boolean(
                (window as InstafyE2EWindow).__INSTAFY_E2E__?.emitConversationMessage &&
                  (window as InstafyE2EWindow).__INSTAFY_E2E__?.createBlankConversation,
              ),
          ),
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const conversationLocalId = await resolveActiveConversationLocalId(page);
    const controllerConversationId = await createBlankControllerConversationId({
      page,
      projectId,
      localConversationId: conversationLocalId,
    });
    const repoUrl = "https://github.com/instafy-dev/test-private-repo.git";
    const repoDir = deriveGithubImportTargetPath("instafy-dev/test-private-repo");
    const helloPath = `${repoDir}/hello.md`;
    const assistantContent = "GitHub access is needed to import instafy-dev/test-private-repo.";
    const integrationRequestMetadata = {
      messageType: "integration_request",
      ui: { suggestedReply: "Import the repo now." },
      details: {
        provider: "github",
        authMethods: ["secret"],
        capabilities: ["private repository clone"],
        suggestedSecretNames: ["GITHUB_TOKEN"],
        suggestedSecrets: [
          {
            name: "GITHUB_TOKEN",
            description: "GitHub token",
          },
        ],
        resumeAction: {
          kind: "github_import",
          repo: repoUrl,
          ref: null,
          targetPath: repoDir,
        },
      },
    };

    await seedControllerConversationMessage(page, {
      projectId,
      conversationId: controllerConversationId,
      role: "assistant",
      content: assistantContent,
      metadata: integrationRequestMetadata,
    });

    const historyFetch = page
      .waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes(`/conversations/${controllerConversationId}/messages`),
        { timeout: 30_000 },
      )
      .catch(() => null);

    await page.evaluate(
      ({ pid, cid, localId, content, metadata }) => {
        (window as InstafyE2EWindow).__INSTAFY_E2E__?.emitConversationMessage?.({
          projectId: pid,
          conversationId: cid,
          role: "assistant",
          content,
          metadata: {
            conversationMetadata: { localId },
            ...metadata,
          },
        });
      },
      {
        pid: projectId,
        cid: controllerConversationId,
        localId: conversationLocalId,
        content: assistantContent,
        metadata: integrationRequestMetadata,
      },
    );

    await historyFetch;

    const requestCard = page.getByTestId("integration-request-card").last();
    await expect(requestCard).toBeVisible({ timeout: 30_000 });
    await expect(requestCard).toContainText("GITHUB_TOKEN");

    const token = (process.env.GH_TESTING_TOKEN ?? "").trim();
    await requestCard.locator('input[name="secret-GITHUB_TOKEN"]').fill(token);
    await requestCard.getByRole("button", { name: "Save secrets" }).click();

    await expect(
      page
        .getByTestId("integration-request-import-resolved")
        .filter({ hasText: "instafy-dev/test-private-repo" }),
    ).toBeVisible({ timeout: 120_000 });

    await expect
      .poll(
        async () => {
          const entries = await listWorkspaceEntries(page, repoDir, { projectId });
          const helloEntry = entries?.find((entry) => entry.path === helloPath) ?? null;
          return helloEntry?.path ?? null;
        },
        { timeout: 120_000 },
      )
      .toBe(helloPath);

    const helloContents = await readWorkspaceFileText(page, helloPath, { projectId });
    expect((helloContents ?? "").trim().length).toBeGreaterThan(0);

    // UI verification: refresh the explorer, expand the cloned repo, and ensure hello.md is visible.
    await page.getByTestId("sidebar-nav-code").click();
    await page.getByTestId("code-search-input").waitFor({ timeout: 10_000 });
    await page.getByTestId("files-explorer-refresh").click();

    const helloTestId = `files-entry-${helloPath.replace(/[^a-zA-Z0-9]/g, "-")}`;

    let currentPath = "";
    for (const segment of repoDir.split("/").filter((entry) => entry.length > 0)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const entryTestId = `files-entry-${currentPath.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const entry = page.getByTestId(entryTestId);
      await expect(entry).toBeVisible({ timeout: 30_000 });
      await entry.click();
    }
    await expect(page.getByTestId(helloTestId)).toBeVisible({ timeout: 30_000 });
  });
});
