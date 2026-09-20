import { test, expect, type Page } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import { randomUUID } from "node:crypto";
import {
  gotoStudio,
  prepareStudio,
  resetRuntimeUserState,
  requestHostedRuntime,
  waitForHostedRuntimeReady
} from "../utils/harness.js";
import { clickQueuedSendNowIfAvailable } from "../utils/chatUi.js";
import { switchToProject } from "../utils/projects.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

async function openProjectSettingsFromSidebar(page: Page, timeout = 30_000) {
  const settingsButton = page.getByTestId("sidebar-project-settings");
  const settingsPanel = page.getByTestId("settings-panel");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openTeamDirectory(page);
    await expect(settingsButton).toBeVisible({ timeout: 15_000 });

    try {
      await settingsButton.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error("Project settings trigger is not an HTMLElement.");
        }
        element.click();
      });
      await expect(settingsPanel).toBeVisible({ timeout });
      return;
    } catch (error) {
      if (attempt >= 1) {
        throw error;
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

async function replaceProjectRouteContext(page: Page, projectId: string) {
  await page.evaluate((pid) => {
    const url = new URL(window.location.href);
    let changed = false;
    if (url.searchParams.get("projectId") !== pid) {
      url.searchParams.set("projectId", pid);
      changed = true;
    }
    // Match the real project picker: conversation routes belong to the
    // previous project and must not be carried into the next workspace.
    for (const key of ["conversationId", "conversationControllerId"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) {
      window.history.replaceState(
        window.history.state,
        document.title,
        `${url.pathname}?${url.searchParams.toString()}${url.hash}`,
      );
    }
  }, projectId);
}

test.describe.serial("Projects - multi workspace flow", () => {
  test.setTimeout(240_000);
  const controllerUrl = process.env.PLAYWRIGHT_CONTROLLER_URL?.trim() || "http://127.0.0.1:8788";

  let touchedProjectIds: string[] = [];

  const trackProjectId = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim();
    if (!trimmed) return;
    if (!touchedProjectIds.includes(trimmed)) {
      touchedProjectIds.push(trimmed);
    }
  };

  const resolveAuthenticatedUserId = async (page: Page) =>
    page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: {
          auth?: {
            getUser?: () => Promise<{ data?: { user?: { id?: string | null } | null } }>;
          };
        };
      };
      const userId = (await runtimeWindow.__INSTAFY_SUPABASE__?.auth?.getUser?.())?.data?.user?.id;
      return typeof userId === "string" && userId.trim().length > 0 ? userId.trim() : null;
    });

  const resolveAuthenticatedAccessToken = async (page: Page) =>
    page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: {
          auth?: {
            getSession?: () => Promise<{
              data?: {
                session?: {
                  access_token?: string | null;
                } | null;
              };
            }>;
          };
        };
      };
      const accessToken =
        (await runtimeWindow.__INSTAFY_SUPABASE__?.auth?.getSession?.())?.data?.session?.access_token;
      return typeof accessToken === "string" && accessToken.trim().length > 0
        ? accessToken.trim()
        : null;
    });

  const resolveActiveOrg = async (page: Page) =>
    page.evaluate(() => {
      const store = (window as any).__INSTAFY_STORE__;
      const state = store?.getState?.();
      const activeProjectId = state?.activeProjectId;
      const org = activeProjectId ? state?.projects?.[activeProjectId]?.org : null;
      const orgId = typeof org?.id === "string" && org.id.trim().length > 0 ? org.id.trim() : null;
      const orgName =
        typeof org?.name === "string" && org.name.trim().length > 0 ? org.name.trim() : null;
      return { orgId, orgName };
    });

  const seedAdditionalProject = async (page: Page, projectName?: string) => {
    const ownerUserId = await resolveAuthenticatedUserId(page).catch(() => null);
    const resolvedProjectName = projectName?.trim() || "Untitled Space";
    const accessToken = await resolveAuthenticatedAccessToken(page).catch(() => null);
    const { orgId, orgName } = await resolveActiveOrg(page).catch(() => ({ orgId: null, orgName: null }));
    if (!orgId || !accessToken) {
      throw new Error("Unable to seed an additional project without the active org id and auth token.");
    }
    const createResponse = await page.context().request.post(
      `${controllerUrl}/orgs/${encodeURIComponent(orgId)}/projects`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          projectType: "customer",
          ownerUserId: ownerUserId ?? undefined,
        },
      }
    );
    if (!createResponse.ok()) {
      const detail = await createResponse.text().catch(() => "");
      throw new Error(`Failed to seed a project in org ${orgId} (${createResponse.status()}): ${detail}`);
    }
    const createdPayload = (await createResponse.json()) as { projectId?: unknown };
    const createdProjectId =
      typeof createdPayload.projectId === "string" && createdPayload.projectId.trim().length > 0
        ? createdPayload.projectId.trim()
        : null;
    if (!createdProjectId) {
      throw new Error(`Seeded project response was missing projectId: ${JSON.stringify(createdPayload)}`);
    }
    if (accessToken) {
      const renameResponse = await page.context().request.patch(
        `${controllerUrl}/projects/${encodeURIComponent(createdProjectId)}`,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          data: {
            projectName: resolvedProjectName,
          },
        }
      );
      if (!renameResponse.ok()) {
        const detail = await renameResponse.text().catch(() => "");
        throw new Error(
          `Failed to seed project name for ${createdProjectId} (${renameResponse.status()}): ${detail}`
        );
      }
    }
    await page.evaluate(
      ({ projectId, orgId, orgName, projectName: nextProjectName }) => {
        const store = (window as any).__INSTAFY_STORE__;
        const state = store?.getState?.();
        if (typeof state?.createProject === "function") {
          state.createProject({
            projectId,
            projectName: nextProjectName,
            orgId,
            orgName
          });
        }
      },
      {
        projectId: createdProjectId,
        orgId,
        orgName: orgName ?? "Untitled Workspace",
        projectName: resolvedProjectName
      }
    );
    return createdProjectId;
  };

  const ensureHostedRuntimeReadyForProject = async (page: Page, projectId: string) => {
    const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      return;
    }
    await gotoStudio(page, { projectId }).catch(() => {});
    await requestHostedRuntime(page, {
      projectId,
      existingRuntimeStrategy: "launch-new",
      timeoutMs: 180_000,
    }).catch(async () => {
      await gotoStudio(page, { projectId }).catch(() => {});
      await requestHostedRuntime(page, {
        projectId,
        existingRuntimeStrategy: "launch-new",
        timeoutMs: 180_000,
      });
    });
    await waitForHostedRuntimeReady(page, 120_000, { projectId });
  };

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    touchedProjectIds = [];
    const projectId = await prepareStudio(page);
    trackProjectId(projectId);
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      source: "projects:multi-switch-cleanup",
      projectIds: touchedProjectIds
    });
  });

  test("switching projects preserves independent conversations", async ({ page }) => {
    const userBubbles = page.getByTestId("chat-bubble-user");
    const sendQueue = page.getByTestId("chat-send-queue");
    const waitForUserBubblePrompt = async (prompt: string, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const texts = await userBubbles.allInnerTexts().catch(() => []);
        if (texts.some((text) => text.includes(prompt))) {
          return;
        }
        const queued = await sendQueue.isVisible().catch(() => false);
        if (queued) {
          await clickQueuedSendNowIfAvailable(page);
        }
        await page.waitForTimeout(250);
      }
      await expect(userBubbles.last()).toContainText(prompt, { timeout: 10_000 });
    };
    const readTopbarName = async () => {
      const text = (await page.getByTestId("topbar-project-name").textContent()) ?? "";
      return text.replace(/\s+/g, " ").trim();
    };
    const waitForActiveProjectId = async (expectedId: string) => {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.__INSTAFY_STORE__?.getState?.().activeProjectId ?? null)),
          { timeout: 20_000 }
        )
        .toBe(expectedId);
    };
    const switchProjectWithoutMenu = async (projectId: string) => {
      const switched = await switchToProject(page, projectId);
      if (!switched) {
        await gotoStudio(page, { projectId });
      } else {
        await replaceProjectRouteContext(page, projectId);
      }
      await waitForActiveProjectId(projectId);
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    };
    const ensureHostedRuntimeReady = async (projectId: string) =>
      ensureHostedRuntimeReadyForProject(page, projectId);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 180_000 });

    const initialProjectId = await page.evaluate(() => {
      const store = window.__INSTAFY_STORE__;
      return store?.getState?.().activeProjectId ?? null;
    });
    if (!initialProjectId) {
      throw new Error("Unable to resolve initial project id");
    }
    trackProjectId(initialProjectId);

    const projectOnePrompt = `Project-one greeting ${Date.now()}`;
    await disableAssistantIfPossible(page).catch(() => false);
    await page.getByTestId("chat-input").fill(projectOnePrompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();
    await waitForUserBubblePrompt(projectOnePrompt, 90_000);

    const secondProjectId = await seedAdditionalProject(page);
    trackProjectId(secondProjectId);
    expect(secondProjectId).not.toBe(initialProjectId);
    await switchProjectWithoutMenu(secondProjectId);
    await ensureHostedRuntimeReady(secondProjectId);
    await disableAssistantIfPossible(page).catch(() => false);

    const secondProjectName = await readTopbarName();
    const projectTwoPrompt = `Project-two ping ${Date.now()}`;
    await page.getByTestId("chat-input").fill(projectTwoPrompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();
    await waitForUserBubblePrompt(projectTwoPrompt, 90_000);

    await switchProjectWithoutMenu(initialProjectId);

    // Ensure the first project's hosted runtime comes back online after switching.
    await ensureHostedRuntimeReady(initialProjectId);
    await disableAssistantIfPossible(page).catch(() => false);
    await waitForUserBubblePrompt(projectOnePrompt, 20_000);

    const followUpPrompt = `Follow up for first project ${Date.now()}`;
    await page.getByTestId("chat-input").fill(followUpPrompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();
    await waitForUserBubblePrompt(followUpPrompt, 90_000);

    await switchProjectWithoutMenu(secondProjectId);
    await ensureHostedRuntimeReady(secondProjectId);
    await waitForUserBubblePrompt(projectTwoPrompt, 20_000);
    await expect(await readTopbarName()).toBe(secondProjectName);
  });

  test.fixme("switching projects mid-run still syncs assistant messages", async ({ page }) => {
    const waitForActiveProjectId = async (expectedId: string) => {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.__INSTAFY_STORE__?.getState?.().activeProjectId ?? null)),
          { timeout: 20_000 }
        )
        .toBe(expectedId);
    };
    const switchProjectWithoutMenu = async (projectId: string) => {
      const switched = await switchToProject(page, projectId);
      if (!switched) {
        await gotoStudio(page, { projectId });
      } else {
        await replaceProjectRouteContext(page, projectId);
      }
      await waitForActiveProjectId(projectId);
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    };
    const ensureHostedRuntimeReady = async (projectId: string) =>
      ensureHostedRuntimeReadyForProject(page, projectId);

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              Boolean(
                (window as any).__INSTAFY_E2E__?.emitConversationMessage &&
                  (window as any).__INSTAFY_E2E__?.createBlankConversation,
              ),
          ),
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const initialProjectId = await page.evaluate(() => {
      return window.__INSTAFY_STORE__?.getState?.().activeProjectId ?? null;
    });
    if (!initialProjectId) {
      throw new Error("Unable to resolve initial project id");
    }
    trackProjectId(initialProjectId);

    const secondProjectId = await seedAdditionalProject(page);
    trackProjectId(secondProjectId);
    expect(secondProjectId).not.toBe(initialProjectId);

    // Switch back to the initial project so we can start a run there.
    await switchProjectWithoutMenu(initialProjectId);
    await ensureHostedRuntimeReady(initialProjectId);

    const promptText = `Hello project switch regression ${Date.now()}`;
    const assistantText = `Stubbed assistant response ${Date.now()}`;
    const baseCreatedAt = new Date().toISOString();
    const assistantCreatedAt = new Date(Date.now() + 1000).toISOString();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const conversationTabs = page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
    await expect(conversationTabs).toHaveCount(1);
    const activeConversationTabId = await conversationTabs.first().getAttribute("data-tab-id");
    if (!activeConversationTabId) {
      throw new Error("Conversation tab missing data-tab-id.");
    }
    const localConversationId = activeConversationTabId.replace("workspace-conversation-", "");
    const controllerConversationId = await page.evaluate(
      async ({ projectId, localId }) =>
        await (window as any).__INSTAFY_E2E__?.createBlankConversation?.({
          projectId,
          metadata: { localId }
        }),
      { projectId: initialProjectId, localId: localConversationId }
    );
    if (typeof controllerConversationId !== "string" || controllerConversationId.trim().length === 0) {
      throw new Error("Unable to create controller conversation for multi-project sync test.");
    }

    await page.evaluate(
      ({ id, projectId, conversationId, localId, content, createdAt }) => {
        (window as any).__INSTAFY_E2E__?.emitConversationMessage?.({
          id,
          projectId,
          conversationId,
          role: "user",
          content,
          metadata: {
            conversationMetadata: { localId }
          },
          createdAt
        });
      },
      {
        id: userMessageId,
        projectId: initialProjectId,
        conversationId: controllerConversationId,
        localId: localConversationId,
        content: promptText,
        createdAt: baseCreatedAt
      }
    );
    await expect(page.getByTestId("chat-bubble-user").last()).toContainText(promptText, { timeout: 10_000 });

    // Switch to project two while the assistant is still processing.
    await switchProjectWithoutMenu(secondProjectId);
    await page.evaluate(
      ({ id, projectId, conversationId, localId, content, createdAt }) => {
        (window as any).__INSTAFY_E2E__?.emitConversationMessage?.({
          id,
          projectId,
          conversationId,
          role: "assistant",
          content,
          metadata: {
            conversationMetadata: { localId }
          },
          createdAt
        });
      },
      {
        id: assistantMessageId,
        projectId: initialProjectId,
        conversationId: controllerConversationId,
        localId: localConversationId,
        content: assistantText,
        createdAt: assistantCreatedAt
      }
    );

    // Switch back and ensure we either keep the typing indicator or sync the assistant response.
    await switchProjectWithoutMenu(initialProjectId);

    const assistantBubble = page.locator('[data-testid="chat-bubble-assistant"]').last();
    await expect(assistantBubble).toContainText(assistantText, { timeout: 10_000 });
  });

  test("renaming project persists across refresh", async ({ page }) => {
    await openProjectSettingsFromSidebar(page, 30_000);

    const newName = `Renamed Project ${Date.now()}`;
    const renameResponse = page.waitForResponse((response) => {
      if (response.request().method() !== "PATCH" || !response.ok()) {
        return false;
      }
      const pathname = new URL(response.url()).pathname;
      if (!/^\/projects\/[0-9a-f-]+$/i.test(pathname)) {
        return false;
      }
      const postData = response.request().postData();
      if (!postData) {
        return false;
      }
      try {
        const parsed = JSON.parse(postData) as { projectName?: unknown };
        return parsed.projectName === newName;
      } catch {
        return false;
      }
    });
    await page.getByTestId("project-settings-name-input").fill(newName);
    await page.getByTestId("project-settings-name-save").click({ noWaitAfter: true });
    await renameResponse;
    await expect(page.getByTestId("topbar-project-name")).toHaveText(newName, { timeout: 30_000 });

    // Refresh and confirm the renamed project persists in the list.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("topbar-project-name")).toHaveText(newName, { timeout: 60_000 });
    await openTeamDirectory(page);
    const refreshedMenu = page.getByTestId("sidebar-project-switcher-menu");
    await expect(refreshedMenu).toBeVisible({ timeout: 15_000 });
    await expect(refreshedMenu.getByText(newName)).toBeVisible();
  });

  test("new projects persist across refresh", async ({ page }) => {
    await expect(page.getByTestId("sidebar-browse-teams")).toBeVisible({ timeout: 30_000 });

    const projectNameA = `Persist A ${Date.now()}`;
    const projectNameB = `Persist B ${Date.now()}`;
    trackProjectId(await seedAdditionalProject(page, projectNameA));
    trackProjectId(await seedAdditionalProject(page, projectNameB));

    // Refresh and confirm both projects show up.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTeamDirectory(page);
    const projectMenu = page.getByTestId("sidebar-project-switcher-menu");
    await expect(projectMenu).toBeVisible({ timeout: 15_000 });
    await expect(projectMenu.getByText(projectNameA)).toBeVisible();
    await expect(projectMenu.getByText(projectNameB)).toBeVisible();
  });
});
