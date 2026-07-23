import { _electron as electron, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElectronStudioChildEnv,
  closeElectronApplication,
  remoteSurfaceHasRenderedFrame,
  remoteSurfaceScreenshotPaint,
} from "../utils/electronBrowserLiveHarness.js";
import {
  clearRuntimePreference,
  deleteDisposableTestUser,
  loginAsGuest,
  prepareStudio,
  resetRuntimeUserState,
  restoreAuthenticatedSession,
  waitForStoreProjectId,
} from "../utils/harness.js";
import {
  SHARED_BROWSER_PRODUCTION_CANARY_ENABLED,
  test,
} from "../utils/sharedBrowserProductionLifecycle.js";
import {
  authenticatedActorLabel,
  collaborationAction,
  collaborationSocketProbeSnapshot,
  collaborationState,
  constrainBrowserPanelForCdp,
  disruptLatestCollaborationSocket,
  expectExistingInputAccepted,
  expectExistingInputRejected,
  latestOpenInputSocket,
  openSharedBrowser,
  sharedPixelSurface,
  sharedSurface,
  waitForOpenInputSocket,
  type CollaborationSocketProbeSnapshot,
} from "../utils/sharedBrowserCollaborationHarness.js";
import {
  expectParticipantPointerAtNormalizedPoint,
  expectResponsiveSharedBrowserLayout,
  hoverSharedSurfaceAtNormalizedPoint,
} from "../utils/sharedBrowserResponsiveHarness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DESKTOP_APP_DIR = path.join(REPO_ROOT, "packages", "desktop-app");
const DESKTOP_APP_DIST_MAIN = path.join(DESKTOP_APP_DIR, "dist", "main.js");
const DESKTOP_APP_REQUIRE = createRequire(path.join(DESKTOP_APP_DIR, "package.json"));
const ENABLED =
  (process.env.PLAYWRIGHT_SHARED_BROWSER_WEB_ELECTRON_COLLABORATION ?? "").trim() === "1";
const APP_BASE_URL = (
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.PLAYWRIGHT_EXTERNAL_BASE_URL ??
  "http://127.0.0.1:5199"
)
  .trim()
  .replace(/\/+$/g, "");
const ARTIFACT_DIR = path.resolve(
  process.env.BROWSER_EXPERIENCE_ARTIFACT_DIR ??
    path.join(REPO_ROOT, "tmp", "browser-experience", "web-electron-collaboration"),
);
const FIRST_TARGET = { x: 158, y: 120 };
const SECOND_TARGET = { x: 158, y: 256 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const PHONE_LANDSCAPE_VIEWPORT = { width: 844, height: 390 };

async function expectExampleDomainComposited(
  page: Page,
  label: string,
) {
  // Capture the containing stage. A canvas-only locator screenshot can read
  // the canvas backing store even while Electron presents a black compositor
  // layer for that canvas, which is exactly the user-visible failure this
  // cross-client proof must catch.
  const surface = page.getByTestId("browser-session-stage");
  let consecutivePaintedSamples = 0;
  await expect
    .poll(async () => {
      const paint = await remoteSurfaceScreenshotPaint(surface);
      const painted =
        paint.brightPixelRatio > 0.65 && paint.darkPixelRatio < 0.15;
      consecutivePaintedSamples = painted ? consecutivePaintedSamples + 1 : 0;
      return consecutivePaintedSamples;
    }, {
      intervals: [250],
      message: `${label} should remain composited and non-black for three consecutive samples`,
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(3);
}

if (
  ENABLED &&
  !SHARED_BROWSER_PRODUCTION_CANARY_ENABLED &&
  !fs.existsSync(DESKTOP_APP_DIST_MAIN)
) {
  throw new Error(
    "Web/Electron Shared Browser collaboration requires a built desktop app. " +
      "Run pnpm --filter @instafy/desktop-app build.",
  );
}

function escapedRegExp(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function openProjectSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function focusConversation(page: Page) {
  const dismissIntro = page.getByRole("button", { name: "Not now" }).first();
  if (await dismissIntro.isVisible().catch(() => false)) {
    await dismissIntro.click();
  }
  const conversationTab = page
    .getByTestId("workspace-tabs")
    .getByRole("button", { name: /Conversation/i })
    .first();
  if (await conversationTab.isVisible().catch(() => false)) {
    await conversationTab.click();
  } else {
    await page.getByTestId("sidebar-nav-chat").click();
  }
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
}

async function captureWebClient(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
) {
  const screenshotPath = path.join(ARTIFACT_DIR, name);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
  return screenshotPath;
}

async function captureElectronClient(
  app: Awaited<ReturnType<typeof electron.launch>>,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
) {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) {
      throw new Error("Electron BrowserWindow is unavailable for screenshot capture.");
    }
    return (await window.capturePage()).toPNG().toString("base64");
  });
  const screenshotPath = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(screenshotPath, Buffer.from(base64, "base64"));
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
  return screenshotPath;
}

async function setElectronContentViewport(
  app: Awaited<ReturnType<typeof electron.launch>>,
  page: Page,
  viewport: { width: number; height: number },
) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    window?.setContentSize(size.width, size.height);
  }, viewport);
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          height: window.innerHeight,
          width: window.innerWidth,
        })),
      { timeout: 15_000 },
    )
    .toEqual(viewport);
}

async function captureBrowserSurface(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
) {
  const modal = page.getByTestId("browser-session-modal");
  const screenshotPath = testInfo.outputPath(name);
  const screenshot = await modal.screenshot({ path: screenshotPath });
  const paint = await remoteSurfaceScreenshotPaint(modal, screenshot);
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
  return { paint, screenshotPath };
}

function expectExampleDomainArtifactPainted(
  artifact: Awaited<ReturnType<typeof captureBrowserSurface>>,
  label: string,
) {
  expect(
    artifact.paint.brightPixelRatio,
    `${label} should contain the predominantly light Example Domain page`,
  ).toBeGreaterThan(0.65);
  expect(
    artifact.paint.darkPixelRatio,
    `${label} must not be an all/mostly-black saved user-visible surface`,
  ).toBeLessThan(0.15);
}

function currentCollaborationEvidence(entries: CollaborationSocketProbeSnapshot[]) {
  const current = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.open &&
        entry.receivedTypes.includes("welcome") &&
        Boolean(entry.latestState),
    );
  const participants = Array.isArray(current?.latestState?.participants)
    ? current.latestState.participants
        .map((participant) =>
          participant && typeof participant === "object" && !Array.isArray(participant)
            ? (participant as Record<string, unknown>)
            : null,
        )
        .filter((participant): participant is Record<string, unknown> => Boolean(participant))
    : [];
  const names = participants
    .map((participant) =>
      typeof participant.displayName === "string" ? participant.displayName : "",
    )
    .filter(Boolean)
    .sort();
  const pageIds = [
    ...new Set(
      participants
        .map((participant) =>
          typeof participant.pageId === "string" ? participant.pageId : "",
        )
        .filter(Boolean),
    ),
  ];
  const controlOwner =
    current?.latestState?.controlOwner &&
    typeof current.latestState.controlOwner === "object" &&
    !Array.isArray(current.latestState.controlOwner)
      ? (current.latestState.controlOwner as Record<string, unknown>)
      : null;
  return {
    entryCount: entries.length,
    participantCount: participants.length,
    participantId: current?.participantId ?? null,
    names,
    pageIds,
    controlOwnerId:
      controlOwner?.kind === "human" && typeof controlOwner.participantId === "string"
        ? controlOwner.participantId
        : null,
  };
}

test.describe("Org Shared Browser web/Electron collaboration", () => {
  test.describe.configure({ retries: 0 });
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_SHARED_BROWSER_WEB_ELECTRON_COLLABORATION=1 for the real cross-client proof.",
  );
  test.setTimeout(600_000);

  test("shares pixels, cursors, control, and reconnect grace across web and Electron", async ({
    page: webPage,
    sharedBrowserProductionLifecycle,
  }, testInfo) => {
    if (!sharedBrowserProductionLifecycle.enabled) {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    }
    webPage.setDefaultTimeout(60_000);
    await webPage.setViewportSize({ width: 1440, height: 900 });
    const productionOwner = sharedBrowserProductionLifecycle.enabled
      ? await sharedBrowserProductionLifecycle.provisionOwner()
      : null;
    const projectId = productionOwner
      ? productionOwner.projectId
      : await prepareStudio(webPage, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for the web/Electron collaboration test.");
    }
    if (productionOwner) {
      await restoreAuthenticatedSession(webPage, productionOwner.session, {
        landingPath: `/studio?projectId=${encodeURIComponent(projectId)}`,
      });
      expect(await waitForStoreProjectId(webPage, projectId, 30_000)).toBe(true);
    }
    await clearRuntimePreference(webPage, {
      projectId,
      source: "org-shared-browser-web-electron-collaboration",
    });

    let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
    let electronUserDataDir: string | null = null;
    let memberDisposableUserId: string | null = null;
    try {
      await openProjectSettings(webPage);
      await webPage.getByTestId("org-invite-link-role").selectOption("builder");
      await webPage.getByTestId("org-invite-link-create").click();
      const inviteLinkUrl = await webPage.getByTestId("org-invite-link-url").inputValue();
      if (!inviteLinkUrl) {
        throw new Error("Shared Browser builder invite link is missing.");
      }
      if (productionOwner) {
        await sharedBrowserProductionLifecycle.trackInviteLink({
          owner: productionOwner,
          inviteUrl: inviteLinkUrl,
          projectId,
        });
      }
      await focusConversation(webPage);
      const ownerLabel = await authenticatedActorLabel(webPage);

      let electronPage: Page;
      if (productionOwner) {
        const collaborator =
          await sharedBrowserProductionLifecycle.provisionCollaborator();
        memberDisposableUserId = collaborator.userId;
        const launched = await sharedBrowserProductionLifecycle.launchElectron(
          collaborator,
          { projectId, restoreSessionToProject: false },
        );
        electronApp = launched.app;
        electronPage = launched.page;
      } else {
        electronUserDataDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "instafy-web-electron-collaboration-"),
        );
        electronApp = await electron.launch({
          executablePath: DESKTOP_APP_REQUIRE("electron"),
          args: [DESKTOP_APP_DIR],
          cwd: REPO_ROOT,
          env: buildElectronStudioChildEnv(process.env, {
            INSTAFY_APP_URL: `${APP_BASE_URL}/login`,
            INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
            INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST: "1",
            INSTAFY_DESKTOP_USER_DATA_DIR: electronUserDataDir,
          }),
        });
        electronPage = await electronApp.firstWindow();
        const memberLogin = await loginAsGuest(electronPage, {
          appBaseUrl: APP_BASE_URL,
        });
        memberDisposableUserId = memberLogin.disposableUserId;
      }
      electronPage.setDefaultTimeout(60_000);
      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed(),
        );
        window?.setSize(1440, 900);
        window?.center();
      });
      expect(electronApp.process().pid).toBeTruthy();
      expect(
        await electronPage.evaluate(
          () => typeof window.instafyDesktop?.connectDefaultCodexAuthJson === "function",
        ),
      ).toBe(true);
      expect(
        await webPage.evaluate(
          () => typeof window.instafyDesktop?.connectDefaultCodexAuthJson === "function",
        ),
      ).toBe(false);

      if (!memberDisposableUserId) {
        throw new Error("The Electron collaborator was not provisioned as a distinct user.");
      }
      await electronPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
      await electronPage.waitForURL((url) => url.pathname.includes("/studio"), {
        timeout: 60_000,
      });
      expect(await waitForStoreProjectId(electronPage, projectId, 30_000)).toBe(true);
      await focusConversation(electronPage);
      const memberLabel = await authenticatedActorLabel(electronPage);
      expect(memberLabel).not.toBe(ownerLabel);
      await setElectronContentViewport(electronApp, electronPage, PHONE_VIEWPORT);

      const ownerBinding = await openSharedBrowser(webPage, { constrainForCdp: false });
      await expect(collaborationState(webPage)).toContainText("You control", {
        timeout: 30_000,
      });
      const ownerAddress = webPage
        .getByTestId("shared-browser-chrome")
        .getByTestId("shared-browser-address");
      await ownerAddress.fill("https://example.com");
      await ownerAddress.press("Enter");
      await expect(ownerAddress).toHaveValue("https://example.com/", { timeout: 60_000 });
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedPixelSurface(webPage)), {
          timeout: 60_000,
        })
        .toBe(true);
      await expectExampleDomainComposited(
        webPage,
        "initial web Shared Browser",
      );

      const memberBinding = await openSharedBrowser(electronPage, {
        constrainForCdp: false,
      });
      expect(memberBinding).toMatchObject({
        originId: ownerBinding.originId,
        runtimeId: ownerBinding.runtimeId,
      });
      expect(memberBinding.browserSessionId).not.toBe(ownerBinding.browserSessionId);
      const memberAddress = electronPage
        .getByTestId("shared-browser-chrome")
        .getByTestId("shared-browser-address");
      await expect(memberAddress).toHaveValue("https://example.com/", { timeout: 60_000 });
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedPixelSurface(electronPage)), {
          timeout: 60_000,
        })
        .toBe(true);
      await expectExampleDomainComposited(
        electronPage,
        "initial Electron Shared Browser",
      );
      await expectResponsiveSharedBrowserLayout(electronPage, {
        minStageHeight: Math.floor(PHONE_VIEWPORT.height * 0.24),
      });

      await expect(webPage.getByTestId("shared-browser-participants")).toHaveAttribute(
        "aria-label",
        escapedRegExp(memberLabel),
        { timeout: 30_000 },
      );
      await expect(electronPage.getByTestId("shared-browser-participants")).toHaveAttribute(
        "aria-label",
        escapedRegExp(ownerLabel),
        { timeout: 30_000 },
      );
      await expect(collaborationState(electronPage)).not.toContainText("You control");
      await expect(collaborationAction(electronPage)).toHaveAttribute(
        "data-action",
        "request",
      );

      const memberCursorPoint = { x: 0.68, y: 0.42 };
      await hoverSharedSurfaceAtNormalizedPoint(electronPage, memberCursorPoint);
      await expect(
        webPage
          .getByTestId("shared-browser-participant-pointer")
          .filter({ hasText: memberLabel }),
      ).toBeVisible({ timeout: 10_000 });
      await expectParticipantPointerAtNormalizedPoint(
        webPage,
        memberLabel,
        memberCursorPoint,
      );
      if (!sharedBrowserProductionLifecycle.enabled) {
        await captureWebClient(
          webPage,
          testInfo,
          "web-owner-with-electron-cursor.png",
        );
      }

      const ownerCursorPoint = { x: 0.44, y: 0.36 };
      await hoverSharedSurfaceAtNormalizedPoint(webPage, ownerCursorPoint);
      await expect(
        electronPage
          .getByTestId("shared-browser-participant-pointer")
          .filter({ hasText: ownerLabel }),
      ).toBeVisible({ timeout: 10_000 });
      await expectParticipantPointerAtNormalizedPoint(
        electronPage,
        ownerLabel,
        ownerCursorPoint,
      );
      if (!sharedBrowserProductionLifecycle.enabled) {
        await captureElectronClient(
          electronApp,
          testInfo,
          "electron-viewer-with-web-cursor.png",
        );
        await captureElectronClient(
          electronApp,
          testInfo,
          "electron-phone-viewer-with-web-cursor.png",
        );
      }

      // Exercise an asymmetric collaboration posture: the controlling web
      // client uses a normal desktop split pane while its Electron teammate
      // remains a phone-width viewer. Neither may replace its signed surface
      // identity or collaboration participant during handoff.
      await constrainBrowserPanelForCdp(webPage);
      await expect(
        webPage.getByTestId("browser-session-stage"),
      ).toHaveAttribute("data-shared-browser-viewer", "cdp-screencast", {
        timeout: 60_000,
      });
      await expect(
        electronPage.getByTestId("browser-session-stage"),
      ).toHaveAttribute("data-shared-browser-viewer", "cdp-screencast", {
        timeout: 60_000,
      });
      await Promise.all([
        waitForOpenInputSocket(webPage),
        waitForOpenInputSocket(electronPage),
      ]);
      const ownerInput = await latestOpenInputSocket(webPage);
      const memberInput = await latestOpenInputSocket(electronPage);
      expect(ownerInput?.pageId).toBeTruthy();
      expect(memberInput?.pageId).toBe(ownerInput?.pageId);
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface(webPage)), {
          timeout: 45_000,
        })
        .toBe(true);
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface(electronPage)), {
          timeout: 45_000,
        })
        .toBe(true);
      await Promise.all([
        expectExampleDomainComposited(
          webPage,
          "constrained web Shared Browser",
        ),
        expectExampleDomainComposited(
          electronPage,
          "constrained Electron Shared Browser",
        ),
      ]);

      await expectExistingInputAccepted(webPage, FIRST_TARGET);
      await expectExistingInputRejected(electronPage, FIRST_TARGET);
      const memberResizeCountBeforeHandoff = memberInput?.resizes.length ?? 0;

      await collaborationAction(electronPage).click();
      await expect(collaborationAction(electronPage)).toBeDisabled();
      await expect(collaborationAction(webPage)).toHaveAttribute("data-action", "grant", {
        timeout: 10_000,
      });
      await collaborationAction(webPage).click();
      await expect(collaborationState(electronPage)).toContainText("You control", {
        timeout: 10_000,
      });
      await expect(sharedSurface(webPage)).toHaveAttribute("data-input-enabled", "false");
      await expect(sharedSurface(electronPage)).toHaveAttribute("data-input-enabled", "true");
      await expectExistingInputRejected(webPage, FIRST_TARGET);
      await expectExistingInputAccepted(electronPage, SECOND_TARGET);
      await expect
        .poll(async () => (await latestOpenInputSocket(electronPage))?.resizes.length ?? 0)
        .toBe(memberResizeCountBeforeHandoff + 1);
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface(electronPage)), {
          message: "Electron should retain a rendered Shared Browser frame after handoff",
          timeout: 45_000,
        })
        .toBe(true);
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface(webPage)), {
          message: "the web viewer should retain a rendered Shared Browser frame after handoff",
          timeout: 45_000,
        })
        .toBe(true);
      await Promise.all([
        expectExampleDomainComposited(
          electronPage,
          "Electron Shared Browser after control handoff",
        ),
        expectExampleDomainComposited(
          webPage,
          "web Shared Browser after control handoff",
        ),
      ]);
      const handoffArtifact = await captureBrowserSurface(
        electronPage,
        testInfo,
        "shared-browser-mixed-electron-after-control-handoff.png",
      );
      expectExampleDomainArtifactPainted(
        handoffArtifact,
        "Electron Shared Browser handoff artifact",
      );

      const memberResizeCountBeforeViewportTransition =
        (await latestOpenInputSocket(electronPage))?.resizes.length ?? 0;
      await setElectronContentViewport(
        electronApp,
        electronPage,
        PHONE_LANDSCAPE_VIEWPORT,
      );
      await expectResponsiveSharedBrowserLayout(electronPage, {
        minStageHeight: 96,
      });
      await expect(collaborationState(electronPage)).toContainText("You control");
      await expect(memberAddress).toHaveValue("https://example.com/");
      await expect
        .poll(async () => {
          const input = await latestOpenInputSocket(electronPage);
          return (
            input?.pageId === ownerInput?.pageId &&
            input.resizes.length > memberResizeCountBeforeViewportTransition
          );
        })
        .toBe(true);

      const ownerCursorAfterResize = { x: 0.57, y: 0.31 };
      await hoverSharedSurfaceAtNormalizedPoint(webPage, ownerCursorAfterResize);
      await expectParticipantPointerAtNormalizedPoint(
        electronPage,
        ownerLabel,
        ownerCursorAfterResize,
      );
      await expectExampleDomainComposited(
        electronPage,
        "landscape Electron Shared Browser after viewport transition",
      );
      if (!sharedBrowserProductionLifecycle.enabled) {
        await captureElectronClient(
          electronApp,
          testInfo,
          "electron-phone-controller-landscape.png",
        );
      }

      const evidenceBeforeDisconnect = currentCollaborationEvidence(
        await collaborationSocketProbeSnapshot(electronPage),
      );
      expect(evidenceBeforeDisconnect).toMatchObject({
        participantCount: 2,
        names: [memberLabel, ownerLabel].sort(),
        pageIds: [ownerInput?.pageId],
      });
      expect(evidenceBeforeDisconnect.participantId).toBeTruthy();
      expect(evidenceBeforeDisconnect.controlOwnerId).toBe(
        evidenceBeforeDisconnect.participantId,
      );

      const disrupted = await disruptLatestCollaborationSocket(electronPage);
      expect(disrupted.participantId).toBe(evidenceBeforeDisconnect.participantId);
      const memberResizeCountBeforeReconnect =
        (await latestOpenInputSocket(electronPage))?.resizes.length ?? 0;
      await expect(sharedSurface(electronPage)).toHaveAttribute(
        "data-input-enabled",
        "false",
        { timeout: 3_000 },
      );
      await expect
        .poll(
          async () =>
            currentCollaborationEvidence(
              await collaborationSocketProbeSnapshot(electronPage),
            ),
          {
            message:
              "Electron should reconnect with the same participant inside the 10-second grace",
            timeout: 9_000,
          },
        )
        .toEqual({
          entryCount: disrupted.entryCount + 1,
          participantCount: 2,
          participantId: evidenceBeforeDisconnect.participantId,
          names: [memberLabel, ownerLabel].sort(),
          pageIds: [ownerInput?.pageId],
          controlOwnerId: evidenceBeforeDisconnect.participantId,
        });
      await expect(collaborationState(electronPage)).toContainText("You control", {
        timeout: 10_000,
      });
      await expect(sharedSurface(electronPage)).toHaveAttribute(
        "data-input-enabled",
        "true",
      );
      await expectExistingInputRejected(webPage, FIRST_TARGET);
      await expectExistingInputAccepted(electronPage, SECOND_TARGET);
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface(electronPage)), {
          message: "Electron should retain a rendered Shared Browser frame after reconnect",
          timeout: 45_000,
        })
        .toBe(true);
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface(webPage)), {
          message: "the web viewer should retain a rendered Shared Browser frame after reconnect",
          timeout: 45_000,
        })
        .toBe(true);
      await Promise.all([
        expectExampleDomainComposited(
          electronPage,
          "Electron Shared Browser after collaboration reconnect",
        ),
        expectExampleDomainComposited(
          webPage,
          "web Shared Browser after Electron collaboration reconnect",
        ),
      ]);
      const reconnectArtifact = await captureBrowserSurface(
        electronPage,
        testInfo,
        "shared-browser-mixed-electron-after-collaboration-reconnect.png",
      );
      expectExampleDomainArtifactPainted(
        reconnectArtifact,
        "Electron Shared Browser reconnect artifact",
      );
      expect((await latestOpenInputSocket(electronPage))?.resizes.length ?? 0).toBe(
        memberResizeCountBeforeReconnect,
      );
      const webReconnectArtifact = await captureBrowserSurface(
        webPage,
        testInfo,
        "shared-browser-mixed-web-after-electron-reconnect.png",
      );
      expectExampleDomainArtifactPainted(
        webReconnectArtifact,
        "web Shared Browser after Electron reconnect artifact",
      );
    } finally {
      if (!sharedBrowserProductionLifecycle.enabled) {
        if (electronApp) {
          await closeElectronApplication(electronApp, 15_000).catch(() => undefined);
        }
        await resetRuntimeUserState(webPage, {
          projectIds: [projectId],
          source: "org-shared-browser-web-electron-collaboration:cleanup",
        }).catch(() => undefined);
        if (memberDisposableUserId) {
          await deleteDisposableTestUser(memberDisposableUserId).catch(() => undefined);
        }
        if (electronUserDataDir) {
          fs.rmSync(electronUserDataDir, { recursive: true, force: true });
        }
      }
    }
  });
});
