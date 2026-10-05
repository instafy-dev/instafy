import { activeConversationId, openChats, selectConversation } from "./utils/conversationNavigation.js";
import { test, expect } from "@playwright/test";
import {
  prepareStudio,
  resetRuntimeUserState,
  resolveWorkspaceProjectId,
  waitForProjectBootstrap,
} from "./utils/harness.js";
import { createPublicChatFromTopBar } from "./utils/chatUi.js";
import { openTeamDirectory, openCreditsPanel, openSecretsPanel } from "./utils/sidebar.js";

interface StudioStoreSnapshot {
  activeProjectId?: string | null;
  projects?: Record<
    string,
    {
      metadata?: {
        prompt?: string | null;
        projectName?: string | null;
      } | null;
      content?: {
        tagline?: string | null;
      } | null;
    }
  >;
}

interface InstafyWindow extends Window {
  __INSTAFY_STORE__?: {
    getState?: () => StudioStoreSnapshot;
  };
}

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (text && !text.startsWith('[vite]')) {
      if(text.includes("Download the React DevTools"))
        return;
      console.log(`⤷ console.${type}: ${text}`);
    }
  });
  page.on('pageerror', (err) => {
    console.error(`⤷ pageerror: ${err.message}`);
  });
  await prepareStudio(page, { waitForHostedRuntime: false });
});

test.afterEach(async ({ page }) => {
  await resetRuntimeUserState(page, { source: "app:cleanup" }).catch(() => {});
});

  test.describe("Instafy Desktop", () => {
    test.setTimeout(120_000);
    test("renders landing hero content", async ({ page }) => {
      await page.goto("/");

      await expect(page.getByTestId("landing-hero-heading")).toBeVisible();
      await expect(page.getByTestId("landing-launch-button")).toBeVisible();
      await expect(page.getByTestId("landing-get-started-button")).toBeVisible();
      await expect(page.getByTestId("landing-integrations")).toBeVisible();
      await expect(page.getByTestId("integration-chip-openai-codex")).toBeVisible();
      await expect(page.getByTestId("integration-chip-github")).toBeVisible();
      await expect(page.getByTestId("integration-chip-gemini")).toHaveText("Gemini");
      await expect(page.getByTestId("integration-chip-kimi")).toContainText("Soon");
      const installLink = page.getByRole("link", { name: "Install Instafy", exact: true });
      await expect(installLink).toHaveAttribute("href", "/install");
      await expect(page.getByText("Install on your phone", { exact: true })).toHaveCount(0);
    });

    test("landing prompt input does not emit console errors", async ({ page }) => {
      test.setTimeout(120_000);

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const location = msg.location();
        const source = location?.url ? `${location.url}:${location.lineNumber ?? 0}` : "";
        consoleErrors.push([msg.text(), source].filter(Boolean).join(" @ "));
      }
    });

    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    page.on("requestfailed", (request) => {
      const failure = request.failure();
      failedRequests.push(`${request.method()} ${request.url()} ${failure?.errorText ?? ""}`.trim());
    });

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // `beforeEach` opens Studio to seed the guest state. Navigating back to
      // the landing page can abort that previous document's in-flight auth
      // request; do not attribute the old document's console event to the
      // landing-to-Studio interaction this assertion is exercising.
      consoleErrors.length = 0;
      pageErrors.length = 0;
      failedRequests.length = 0;

      await page.getByTestId("landing-get-started-button").click();

      await expect(page).toHaveURL(/\/studio/);

      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });


      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);

    const relevantFailedRequests = failedRequests.filter((entry) =>
      !entry.includes("/rest/v1/projects") &&
      !entry.includes("/rest/v1/sites") &&
      !entry.includes("/events?") &&
      !entry.includes("net::ERR_ABORTED")
    );

    expect(relevantFailedRequests, relevantFailedRequests.join("\n")).toHaveLength(0);
  });

    test("landing prompt creates a guest project", async ({ page }) => {
      test.setTimeout(120_000);

      await page.goto("/");
      await page.getByTestId("landing-get-started-button").click();

      await expect(page).toHaveURL(/\/studio/);
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

      const projectSnapshot = await page.evaluate(() => {
        const store = (window as InstafyWindow).__INSTAFY_STORE__;
        const state = store?.getState?.();
      if (!state) {
        return null;
      }
      const activeProjectId = state.activeProjectId ?? null;
      const projects = state.projects ?? {};
      const activeProject = activeProjectId ? projects[activeProjectId] ?? null : null;
      const metadata = activeProject?.metadata ?? null;
      const content = activeProject?.content ?? null;
      return {
        activeProjectId,
        projectCount: Object.keys(projects).length,
        prompt: metadata?.prompt ?? null,
        projectName: metadata?.projectName ?? null,
        contentTagline: content?.tagline ?? null
      };
    });

    expect(projectSnapshot).not.toBeNull();
    expect(projectSnapshot?.activeProjectId).toBeTruthy();
    expect(projectSnapshot?.projectCount ?? 0).toBeGreaterThan(0);
    expect(projectSnapshot?.prompt ?? "").toBe("");
    // A space nobody named is stored without a name and shown as untitled.
    expect(projectSnapshot?.projectName ?? "").toBe("");
    expect(projectSnapshot?.contentTagline ?? "").toBe("");
    await expect(page.getByTestId("topbar-project-name")).toHaveText("Untitled space");
  });

  const loadsStudioTest = test;

  loadsStudioTest("loads studio with project controls", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

  /*   await expect(page.getByText(/Pick a quick action/i)).toBeVisible();  TODO later */
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sidebar-browse-teams")).toBeVisible();
    await openTeamDirectory(page);
    await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
    await expect(page.getByTestId("sidebar-project-new")).toBeVisible();
  });

  loadsStudioTest("offers a verified Desktop release above the account avatar in wide web Studio", async ({ page }) => {
    test.setTimeout(60_000);
    const version = "0.2.0";
    const stableBaseUrl = "https://downloads.instafy.dev/desktop-app/stable";
    await page.route("https://downloads.instafy.dev/desktop-app/latest.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "access-control-expose-headers": "X-Instafy-Desktop-Release",
          "x-instafy-desktop-release": "desktop-app-v0.2.0",
        },
        body: JSON.stringify({
          version,
          tag: `desktop-app-v${version}`,
          channel: "stable",
          feedUrl: stableBaseUrl,
          publishedAt: "2026-07-22T10:00:00.000Z",
          sourceSha: "a".repeat(40),
          architectures: { mac: ["arm64"] },
          artifacts: {
            macDmg: `${stableBaseUrl}/instafy-${version}-mac-arm64.dmg`,
            macZip: `${stableBaseUrl}/instafy-${version}-mac-arm64.zip`,
            windowsExe: `${stableBaseUrl}/instafy-${version}-win.exe`,
          },
        }),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/studio");

    const sidebarInstall = page.getByTestId("sidebar-get-desktop");
    const profileTrigger = page.getByTestId("sidebar-profile-menu");
    await expect(sidebarInstall).toBeVisible({ timeout: 15_000 });
    await expect(sidebarInstall).toHaveAccessibleName("Get desktop app");
    await expect(sidebarInstall).toHaveAttribute("href", "/install#desktop");
    await expect(sidebarInstall).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("topbar-get-desktop")).toHaveCount(0);
    await expect(page.locator('header[aria-label$="workspace navigation"] a[href^="/install"]')).toHaveCount(0);

    const installBounds = await sidebarInstall.boundingBox();
    const profileBounds = await profileTrigger.boundingBox();
    if (!installBounds || !profileBounds) {
      throw new Error("Unable to measure the desktop acquisition and account controls.");
    }
    expect(installBounds.y + installBounds.height).toBeLessThanOrEqual(profileBounds.y);

    await profileTrigger.click();
    await expect(page.getByTestId("notifications-toggle-button")).toBeVisible();
    await expect(page.getByTestId("profile-install-button")).toHaveCount(0);
    await expect(sidebarInstall).toBeVisible();
  });

  loadsStudioTest("fresh preparation remounts initialized project access", async ({ page }) => {
    test.setTimeout(120_000);

    const initializedProjectId = await resolveWorkspaceProjectId(page);
    expect(initializedProjectId).toBeTruthy();
    expect(await waitForProjectBootstrap(page, initializedProjectId!, 15_000)).toBe(true);

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();
    expect(projectId).toBe(initializedProjectId);

    const projectState = await page.evaluate(() => {
      const runtimeWindow = window as InstafyWindow & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
      };
      return {
        activeProjectId: runtimeWindow.__INSTAFY_STORE__?.getState?.().activeProjectId ?? null,
        explicitProjectId: runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ ?? null,
        initialized: runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ === true,
        urlProjectId: new URL(window.location.href).searchParams.get("projectId"),
      };
    });

    expect(projectState).toEqual({
      activeProjectId: projectId,
      explicitProjectId: projectId,
      initialized: true,
      urlProjectId: projectId,
    });
    await expect(page.getByTestId("project-read-only-notice")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toHaveAttribute("aria-readonly", "false");
    await expect(page.getByTestId("chat-input")).toHaveAttribute("contenteditable", "true");

    const staleProjectId = await page.evaluate(() => {
      const projectId = crypto.randomUUID();
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
        __INSTAFY_STORE__?: {
          getState?: () => {
            createProject?: (input: { projectId: string; projectName: string }) => void;
            switchProject?: (projectId: string) => void;
          };
        };
      };
      const store = runtimeWindow.__INSTAFY_STORE__?.getState?.();
      store?.createProject?.({ projectId, projectName: "Stale project" });
      store?.switchProject?.(projectId);
      runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = projectId;
      runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
      const url = new URL(window.location.href);
      url.searchParams.set("projectId", projectId);
      window.history.replaceState(window.history.state, document.title, url);
      return projectId;
    });

    const replacementProjectId = await prepareStudio(page, {
      reuseExisting: true,
      waitForHostedRuntime: false,
    });
    expect(replacementProjectId).toBeTruthy();
    expect(replacementProjectId).not.toBe(staleProjectId);
    expect(await waitForProjectBootstrap(page, replacementProjectId!, 15_000)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`projectId=${replacementProjectId}`));
    await expect(page.getByTestId("project-read-only-notice")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toHaveAttribute("aria-readonly", "false");
    await expect(page.getByTestId("chat-input")).toHaveAttribute("contenteditable", "true");
  });

  loadsStudioTest("workspace tab switches add browser history", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    const projectId = await resolveWorkspaceProjectId(page);
    expect(projectId).toBeTruthy();
    const bootstrapReady = await waitForProjectBootstrap(page, projectId!, 15_000);
    expect(bootstrapReady).toBe(true);

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("panel") === "secrets", { timeout: 15_000 }),
      openSecretsPanel(page),
    ]);
    await expect(page.getByTestId("secrets-panel")).toBeVisible();

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("panel") === "credits", { timeout: 15_000 }),
      openCreditsPanel(page),
    ]);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("panel") === "secrets", { timeout: 15_000 }),
      openSecretsPanel(page),
    ]);
    await expect(page.getByTestId("secrets-panel")).toBeVisible();

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("panel") === "credits", { timeout: 15_000 }),
      page.goBack(),
    ]);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible({ timeout: 15_000 });
  });

  loadsStudioTest("Home and panels return to the current chat without accumulating tabs", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    const title = page.getByTestId("conversation-workspace-title");
    const conversationTitle = (await title.innerText()).trim();
    const conversationId = await activeConversationId(page);

    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("studio-home-title")).toHaveText("Home");
    await expect(page.getByRole("button", { name: "Close Home", exact: true })).toHaveCount(0);
    await page.getByTestId("home-resume-conversation").click();
    await expect(title).toHaveText(conversationTitle);
    expect(await activeConversationId(page)).toBe(conversationId);

    await openSecretsPanel(page);
    await expect(title).toHaveText("Secrets");
    await page.getByRole("button", { name: `Return to ${conversationTitle}`, exact: true }).click();
    await expect(title).toHaveText(conversationTitle);
    await expect(page.getByTestId("workspace-tabs")).toHaveCount(0);
  });

  loadsStudioTest("new chat menu anchors from the plus button start edge", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    const trigger = page.getByTestId("sidebar-new-chat");
    await trigger.click();

    const popover = page.getByTestId("chat-new-chat-menu-popover");
    await expect(popover).toBeVisible();

    const triggerBox = await trigger.boundingBox();
    const popoverBox = await popover.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(Math.abs((popoverBox?.x ?? 0) - (triggerBox?.x ?? 0))).toBeLessThanOrEqual(2);
    expect((popoverBox?.y ?? 0)).toBeGreaterThan((triggerBox?.y ?? 0) + (triggerBox?.height ?? 0) - 1);

    await page.mouse.click(20, 20);
    await expect(popover).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const button = document.querySelector('[data-testid="sidebar-new-chat"]');
          return button ? button.matches(":focus-visible") : false;
        }),
      )
      .toBe(false);
  });

  loadsStudioTest("switches chats through the explorer without creating global tabs", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    const first = await activeConversationId(page);
    await createPublicChatFromTopBar(page);
    const second = await activeConversationId(page);
    await createPublicChatFromTopBar(page);
    const third = await activeConversationId(page);
    expect(new Set([first, second, third]).size).toBe(3);
    await openChats(page);
    await expect(page.getByTestId("conversation-history-item")).toHaveCount(3);
    await selectConversation(page, first);
    await expect(page.getByTestId("conversation-history-item").filter({ hasText: "Conversation 1" })).toHaveAttribute("aria-current", "page");
    await selectConversation(page, third);
    await expect(page.getByTestId("workspace-tabs")).toHaveCount(0);
  });
});
