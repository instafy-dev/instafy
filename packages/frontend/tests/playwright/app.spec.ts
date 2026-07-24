import { test, expect } from "@playwright/test";
import {
  prepareStudio,
  resetRuntimeUserState,
  resolveWorkspaceProjectId,
  waitForProjectBootstrap,
} from "./utils/harness.js";
import { createPublicChatFromTopBar } from "./utils/chatUi.js";
import { openCreditsPanel, openSecretsPanel } from "./utils/sidebar.js";

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

async function conversationTabIds(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]').evaluateAll((nodes) =>
    nodes
      .map((node) => (node instanceof HTMLElement ? node.dataset.tabId ?? "" : ""))
      .filter((value) => value.trim().length > 0)
  );
}

async function dragTab(page: import("@playwright/test").Page, source: import("@playwright/test").Locator, target: import("@playwright/test").Locator) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Unable to measure workspace tab bounds.");
  }
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + Math.min(targetBox.width * 0.3, 24);
  const targetY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX + 12, sourceY, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 14 });
  await page.mouse.up();
}

async function captureActiveWorkspaceTabSequence(
  page: import("@playwright/test").Page,
  action: () => Promise<void>,
): Promise<string[]> {
  await page.evaluate(() => {
    const transitions: string[] = [];
    const collect = () => {
      const tabs = Array.from(document.querySelectorAll("[data-testid='workspace-tabs'] [data-tab-id]"));
      const active =
        tabs.find((node) => node.getAttribute("aria-current") === "page")?.textContent?.trim() ?? null;
      if (active) {
        transitions.push(active);
      }
    };

    collect();
    (window as typeof window & { __workspaceTabObserver?: MutationObserver }).__workspaceTabObserver?.disconnect();

    const observer = new MutationObserver(() => collect());
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-current", "class"],
    });

    (
      window as typeof window & {
        __workspaceTabTransitions?: string[];
        __workspaceTabObserver?: MutationObserver;
      }
    ).__workspaceTabTransitions = transitions;
    (
      window as typeof window & {
        __workspaceTabTransitions?: string[];
        __workspaceTabObserver?: MutationObserver;
      }
    ).__workspaceTabObserver = observer;
  });

  await action();
  await page.waitForTimeout(500);

  return await page.evaluate(() => {
    const state = window as typeof window & {
      __workspaceTabTransitions?: string[];
      __workspaceTabObserver?: MutationObserver;
    };
    state.__workspaceTabObserver?.disconnect();
    const deduped: string[] = [];
    for (const value of state.__workspaceTabTransitions ?? []) {
      if (deduped[deduped.length - 1] !== value) {
        deduped.push(value);
      }
    }
    return deduped;
  });
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

  test.describe("Instafy Studio", () => {
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
    expect(projectSnapshot?.projectName ?? "").not.toHaveLength(0);
    expect(projectSnapshot?.contentTagline ?? "").toBe("");
  });

  const loadsStudioTest = test;

  loadsStudioTest("loads studio with project controls", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

  /*   await expect(page.getByText(/Pick a quick action/i)).toBeVisible();  TODO later */
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sidebar-project-button")).toBeVisible();
    await page.getByTestId("sidebar-project-button").click();
    await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
    await expect(page.getByTestId("sidebar-project-new")).toBeVisible();
  });

  loadsStudioTest("offers a verified Desktop release from wide web Studio", async ({ page }) => {
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
            macDmg: `${stableBaseUrl}/instafy-studio-${version}-mac-arm64.dmg`,
            macZip: `${stableBaseUrl}/instafy-studio-${version}-mac-arm64.zip`,
            windowsExe: `${stableBaseUrl}/instafy-studio-${version}-win.exe`,
          },
        }),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/studio");

    const topbarInstall = page.getByTestId("topbar-get-desktop");
    await expect(topbarInstall).toBeVisible({ timeout: 15_000 });
    await expect(topbarInstall).toHaveText("Get Desktop");
    await expect(topbarInstall).toHaveAttribute("href", "/install#desktop");
    await expect(topbarInstall).toHaveAttribute("target", "_blank");

    await page.getByTestId("sidebar-profile-menu").click();
    const accountInstall = page.getByTestId("profile-install-button");
    await expect(accountInstall).toBeVisible();
    await expect(accountInstall).toHaveAttribute("href", "/install#desktop");
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
      page
        .getByTestId("workspace-tabs")
        .getByRole("button", { name: /Secrets/ })
        .first()
        .click(),
    ]);
    await expect(page.getByTestId("secrets-panel")).toBeVisible();

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("panel") === "credits", { timeout: 15_000 }),
      page.goBack(),
    ]);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible({ timeout: 15_000 });
  });

  loadsStudioTest("conversation tabs do not flicker through panel tabs", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

    const conversationTab = page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]').first();
    const conversationTitle = ((await conversationTab.textContent()) ?? "").trim();
    expect(conversationTitle).not.toHaveLength(0);

    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("workspace-tabs").locator('[data-tab-id="workspace-tab-home"]')).toHaveAttribute(
      "aria-current",
      "page",
    );

    const homeSequence = await captureActiveWorkspaceTabSequence(page, async () => {
      await conversationTab.click();
    });
    expect(homeSequence).toEqual(["Home", conversationTitle]);

    await openSecretsPanel(page);
    await expect(page.getByTestId("secrets-panel")).toBeVisible();
    await expect(
      page.getByTestId("workspace-tabs").locator('[data-tab-id="workspace-tab-secrets"]'),
    ).toHaveAttribute("aria-current", "page");

    const secretsSequence = await captureActiveWorkspaceTabSequence(page, async () => {
      await conversationTab.click();
    });
    expect(secretsSequence).toEqual(["Secrets", conversationTitle]);
  });

  loadsStudioTest("new chat menu anchors from the plus button start edge", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("workspace-tabs").locator('[data-tab-id="workspace-tab-home"]')).toHaveAttribute(
      "aria-current",
      "page",
    );

    const trigger = page.getByTestId("chat-new-conversation");
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
          const button = document.querySelector('[data-testid="chat-new-conversation"]');
          return button ? button.matches(":focus-visible") : false;
        }),
      )
      .toBe(false);
  });

  loadsStudioTest("home tab can be closed and reopened", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("sidebar-home-button").click();

    const homeTab = page.getByTestId("workspace-tabs").locator('[data-tab-id="workspace-tab-home"]');
    await expect(homeTab).toHaveAttribute("aria-current", "page");
    const closeHomeButton = page.getByRole("button", { name: "Close Home", exact: true });
    await expect(closeHomeButton).toBeVisible();

    await closeHomeButton.click();
    await expect(homeTab).toHaveCount(0);

    await page.getByTestId("sidebar-home-button").click();
    await expect(homeTab).toHaveCount(1);
    await expect(homeTab).toHaveAttribute("aria-current", "page");
  });

  loadsStudioTest("conversation tabs can be reordered in the desktop tab strip", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/studio");
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

    await createPublicChatFromTopBar(page);
    await createPublicChatFromTopBar(page);

    const conversationTabs = page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
    await expect(conversationTabs).toHaveCount(3);
    await expect.poll(() => conversationTabIds(page)).toHaveLength(3);
    const orderedTabIds = await conversationTabIds(page);
    expect(new Set(orderedTabIds).size).toBe(3);

    await dragTab(page, conversationTabs.nth(2), conversationTabs.nth(0));

    await expect.poll(() => conversationTabIds(page)).toEqual([
      orderedTabIds[2],
      orderedTabIds[0],
      orderedTabIds[1],
    ]);
  });


});
