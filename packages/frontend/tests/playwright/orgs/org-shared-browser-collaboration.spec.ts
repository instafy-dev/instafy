import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  clearRuntimePreference,
  deleteDisposableTestUser,
  loginAsGuest,
  prepareStudio,
  resetRuntimeUserState,
  waitForStoreProjectId,
} from "../utils/harness.js";
import {
  authenticatedActorLabel,
  collaborationAction,
  collaborationState,
  expectExistingInputAccepted,
  expectExistingInputRejected,
  expectSharedBlankSurfacePainted,
  openSharedBrowser,
  sharedSurface,
  waitForOpenInputSocket,
} from "../utils/sharedBrowserCollaborationHarness.js";

const ENABLED =
  (process.env.PLAYWRIGHT_SHARED_BROWSER_COLLABORATION ?? "").trim() === "1";
const FIRST_TARGET = { x: 158, y: 120 };
const SECOND_TARGET = { x: 158, y: 256 };

type CollaborationFrame = {
  actor: "owner" | "member";
  direction: "sent" | "received" | "closed" | "error";
  payload: string;
  socketId: number;
};

function captureCollaborationFrames(
  page: Page,
  actor: CollaborationFrame["actor"],
  frames: CollaborationFrame[],
) {
  let socketCount = 0;
  page.on("websocket", (socket) => {
    let pathname = "";
    try {
      pathname = new URL(socket.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.endsWith("/browser/collaboration")) {
      return;
    }
    socketCount += 1;
    const socketId = socketCount;
    const record = (
      direction: CollaborationFrame["direction"],
      payload: string,
    ) => {
      frames.push({
        actor,
        direction,
        payload,
        socketId,
      });
    };
    socket.on("framesent", ({ payload }) => {
      record("sent", String(payload));
    });
    socket.on("framereceived", ({ payload }) => {
      record("received", String(payload));
    });
    socket.on("close", () => {
      record("closed", "");
    });
    socket.on("socketerror", (error) => {
      record("error", String(error));
    });
  });
}

function collaborationFramePayload(frame: CollaborationFrame): Record<string, unknown> | null {
  if (!frame.payload) {
    return null;
  }
  try {
    const value = JSON.parse(frame.payload) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function memberCursorWireState(
  frames: CollaborationFrame[],
  memberLabel: string,
) {
  const cursorSocketIds = new Set(
    frames
      .filter((frame) => {
        const payload = collaborationFramePayload(frame);
        return (
          frame.actor === "member" &&
          frame.direction === "sent" &&
          payload?.type === "cursor"
        );
      })
      .map((frame) => frame.socketId),
  );
  const memberSentCursor = cursorSocketIds.size > 0;
  const ownerReceivedCursor = frames.some((frame) => {
    const payload = collaborationFramePayload(frame);
    if (frame.actor !== "owner" || frame.direction !== "received" || payload?.type !== "state") {
      return false;
    }
    const participants = Array.isArray(payload.participants) ? payload.participants : [];
    return participants.some((participant) => {
      if (!participant || typeof participant !== "object" || Array.isArray(participant)) {
        return false;
      }
      const record = participant as Record<string, unknown>;
      return (
        record.displayName === memberLabel &&
        Boolean(record.cursor) &&
        typeof record.cursor === "object" &&
        !Array.isArray(record.cursor)
      );
    });
  });
  const memberSocketClosed = frames.some(
    (frame) =>
      frame.actor === "member" &&
      frame.direction === "closed" &&
      cursorSocketIds.has(frame.socketId),
  );
  return { memberSentCursor, ownerReceivedCursor, memberSocketClosed };
}

async function openProjectSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

test.describe("Org Shared Browser collaboration", () => {
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_SHARED_BROWSER_COLLABORATION=1 and use the browser-enabled runtime image.",
  );
  test.setTimeout(480_000);

  let activeProjectId: string | null = null;

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      projectIds: [activeProjectId],
      source: "org-shared-browser-collaboration:cleanup",
    }).catch(() => {});
    activeProjectId = null;
  });

  test("shares one page and gives exactly one named human control", async ({
    page,
    browser,
  }, testInfo) => {
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for Shared Browser collaboration test.");
    }
    activeProjectId = projectId;
    await clearRuntimePreference(page, {
      projectId,
      source: "org-shared-browser-collaboration",
    });

    let memberContext: BrowserContext | null = null;
    let memberDisposableUserId: string | null = null;
    const collaborationFrames: CollaborationFrame[] = [];
    captureCollaborationFrames(page, "owner", collaborationFrames);
    try {
      await openProjectSettings(page);
      await page.getByTestId("org-invite-link-role").selectOption("builder");
      await page.getByTestId("org-invite-link-create").click();
      const inviteLinkUrl = await page.getByTestId("org-invite-link-url").inputValue();
      if (!inviteLinkUrl) {
        throw new Error("Shared Browser builder invite link is missing.");
      }
      await page.getByTestId("sidebar-nav-chat").click();
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

      memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const memberPage = await memberContext.newPage();
      captureCollaborationFrames(memberPage, "member", collaborationFrames);
      const memberLogin = await loginAsGuest(memberPage);
      memberDisposableUserId = memberLogin.disposableUserId;
      await memberPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
      await memberPage.waitForURL((url) => url.pathname.includes("/studio"), {
        timeout: 60_000,
      });
      expect(await waitForStoreProjectId(memberPage, projectId, 20_000)).toBe(true);
      await memberPage.getByTestId("sidebar-nav-chat").click();
      await expect(memberPage.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
      const memberLabel = await authenticatedActorLabel(memberPage);

      const ownerBinding = await openSharedBrowser(page);
      await expectSharedBlankSurfacePainted(page);
      await expect(collaborationState(page)).toContainText("You control", {
        timeout: 30_000,
      });
      await waitForOpenInputSocket(page);

      const memberBinding = await openSharedBrowser(memberPage);
      expect(memberBinding).toMatchObject({
        originId: ownerBinding.originId,
        runtimeId: ownerBinding.runtimeId,
      });
      expect(memberBinding.browserSessionId).not.toBe(ownerBinding.browserSessionId);
      await expectSharedBlankSurfacePainted(memberPage);
      await expect(page.getByTestId("shared-browser-participants")).toHaveAttribute(
        "aria-label",
        new RegExp(memberLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        { timeout: 30_000 },
      );
      await expect(collaborationState(memberPage)).not.toContainText("You control");
      await expect(collaborationAction(memberPage)).toHaveAttribute("data-action", "request");
      await waitForOpenInputSocket(memberPage);

      const memberSurface = sharedSurface(memberPage);
      await memberSurface.hover({ position: { x: 340, y: 340 }, force: true });
      await expect
        .poll(() => memberCursorWireState(collaborationFrames, memberLabel), {
          message: "the member cursor should reach the owner's collaboration socket",
        })
        .toEqual({
          memberSentCursor: true,
          ownerReceivedCursor: true,
          memberSocketClosed: false,
        });
      const memberPointer = page
        .getByTestId("shared-browser-participant-pointer")
        .filter({ hasText: memberLabel });
      await expect(memberPointer).toBeVisible({ timeout: 10_000 });
      const presenceScreenshot = testInfo.outputPath("shared-browser-owner-presence.png");
      await page.getByTestId("browser-session-modal").screenshot({ path: presenceScreenshot });
      await testInfo.attach("Shared Browser owner with teammate cursor", {
        path: presenceScreenshot,
        contentType: "image/png",
      });

      await expectExistingInputAccepted(page, FIRST_TARGET);
      await expectExistingInputRejected(memberPage, FIRST_TARGET);

      await collaborationAction(memberPage).click();
      await expect(collaborationAction(memberPage)).toHaveAttribute("data-action", "request");
      await expect(collaborationAction(memberPage)).toBeDisabled();
      await expect(collaborationAction(page)).toHaveAttribute("data-action", "grant", {
        timeout: 10_000,
      });
      await collaborationAction(page).click();
      await expect(collaborationState(memberPage)).toContainText("You control", {
        timeout: 10_000,
      });
      await expect(sharedSurface(page)).toHaveAttribute("data-input-enabled", "false");
      await expect(sharedSurface(memberPage)).toHaveAttribute("data-input-enabled", "true");

      await expectExistingInputRejected(page, FIRST_TARGET);
      await expectExistingInputAccepted(memberPage, SECOND_TARGET);
      await expectSharedBlankSurfacePainted(memberPage);
      const handoffScreenshot = testInfo.outputPath("shared-browser-new-driver.png");
      await memberPage
        .getByTestId("browser-session-modal")
        .screenshot({ path: handoffScreenshot });
      await testInfo.attach("Shared Browser after control handoff", {
        path: handoffScreenshot,
        contentType: "image/png",
      });
    } finally {
      await memberContext?.close().catch(() => {});
      if (memberDisposableUserId) {
        await deleteDisposableTestUser(memberDisposableUserId).catch(() => {});
      }
    }
  });
});
