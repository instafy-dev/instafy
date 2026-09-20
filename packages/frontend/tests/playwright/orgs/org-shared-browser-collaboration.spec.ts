import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import { parseSharedBrowserCollaborationServerMessage } from "../../../src/screens/studio/components/sharedBrowserCollaboration.js";

import {
  clearRuntimePreference,
  deleteDisposableTestUser,
  loginAsGuest,
  prepareStudio,
  resetRuntimeUserState,
  waitForStoreProjectId,
} from "../utils/harness.js";
import {
import { chooseOption } from "../utils/select.js";
  authenticatedActorLabel,
  collaborationAction,
  collaborationSocketProbeSnapshot,
  collaborationState,
  disruptLatestCollaborationSocket,
  expectExistingInputAccepted,
  expectExistingInputRejected,
  expectSharedBlankSurfacePainted,
  inputSocketProbeSnapshot,
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
  await openTeamDirectory(page);
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function currentCollaboration(page: Page) {
  const entries = await collaborationSocketProbeSnapshot(page);
  const entry = entries.filter((candidate) => candidate.open).at(-1);
  const message = parseSharedBrowserCollaborationServerMessage(entry?.latestState);
  if (!entry?.participantId || message?.type !== "state") return null;
  return {
    participantId: entry.participantId,
    state: message,
    entryCount: entries.length,
  };
}

test.describe("Org Shared Browser collaboration", () => {
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_SHARED_BROWSER_COLLABORATION=1 and use the browser-enabled runtime image.",
  );
  test.setTimeout(480_000);

  let activeProjectId: string | null = null;
  let disposableOwnerUserId: string | null = null;

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      projectIds: [activeProjectId],
      source: "org-shared-browser-collaboration:cleanup",
    }).catch(() => {});
    activeProjectId = null;
    if (disposableOwnerUserId) {
      const userId = disposableOwnerUserId;
      disposableOwnerUserId = null;
      await deleteDisposableTestUser(userId);
    }
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
      await chooseOption(page.getByTestId("org-invite-link-role"), "builder");
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

  test("shares one driver across two devices of one account and a read-only teammate", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    disposableOwnerUserId = (await loginAsGuest(page)).disposableUserId;
    expect(disposableOwnerUserId, "three-participant fixture requires a disposable owner").toBeTruthy();
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) throw new Error("Project id missing for three-participant collaboration.");
    activeProjectId = projectId;
    await clearRuntimePreference(page, {
      projectId,
      source: "org-shared-browser-collaboration:three-participants",
    });
    let secondDeviceContext: BrowserContext | null = null;
    let viewerContext: BrowserContext | null = null;
    let viewerUserId: string | null = null;
    try {
      await openProjectSettings(page);
      await chooseOption(page.getByTestId("org-invite-link-role"), "viewer");
      await page.getByTestId("org-invite-link-create").click();
      const inviteUrl = await page.getByTestId("org-invite-link-url").inputValue();
      if (!inviteUrl) throw new Error("Shared Browser read-only invite link is missing.");
      await page.getByTestId("sidebar-nav-chat").click();
      await expect(page.getByTestId("chat-input")).toBeVisible();

      // Copy only this test account's browser state, in memory, to model its
      // second device. Never write signed sessions to retained test artifacts.
      secondDeviceContext = await browser.newContext({
        storageState: await page.context().storageState(),
        viewport: { width: 1440, height: 900 },
      });
      const secondDevice = await secondDeviceContext.newPage();
      const secondDeviceUrl = new URL(page.url());
      secondDeviceUrl.searchParams.set("projectId", projectId);
      secondDeviceUrl.searchParams.set("panel", "chat");
      await secondDevice.goto(secondDeviceUrl.toString(), { waitUntil: "domcontentloaded" });
      expect(await waitForStoreProjectId(secondDevice, projectId, 30_000)).toBe(true);
      await secondDevice.getByTestId("sidebar-nav-chat").click();
      await expect(secondDevice.getByTestId("chat-input")).toBeVisible();
      expect(await authenticatedActorLabel(secondDevice)).toBe(await authenticatedActorLabel(page));
      expect(await secondDevice.evaluate(async (ownerUserId) => {
        const client = (window as Window & {
          __INSTAFY_SUPABASE__?: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } };
        }).__INSTAFY_SUPABASE__;
        return (await client?.auth.getUser())?.data.user?.id === ownerUserId;
      }, disposableOwnerUserId)).toBe(true);

      viewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const viewer = await viewerContext.newPage();
      viewerUserId = (await loginAsGuest(viewer)).disposableUserId;
      expect(viewerUserId, "read-only participant must be a separate disposable user").toBeTruthy();
      expect(viewerUserId).not.toBe(disposableOwnerUserId);
      await viewer.goto(inviteUrl, { waitUntil: "domcontentloaded" });
      await viewer.waitForURL((url) => url.pathname.includes("/studio"));
      expect(await waitForStoreProjectId(viewer, projectId, 30_000)).toBe(true);
      await viewer.getByTestId("sidebar-nav-chat").click();

      const firstBinding = await openSharedBrowser(page);
      await expect(collaborationState(page)).toContainText("You control");
      const secondBinding = await openSharedBrowser(secondDevice);
      const viewerBinding = await openSharedBrowser(viewer, { access: "view" });
      for (const binding of [secondBinding, viewerBinding]) {
        expect(binding).toMatchObject({ runtimeId: firstBinding.runtimeId, originId: firstBinding.originId });
      }
      expect(new Set([firstBinding, secondBinding, viewerBinding].map((binding) => binding.browserSessionId)).size).toBe(3);
      const pages = [page, secondDevice, viewer];
      for (const participantPage of pages) {
        await expectSharedBlankSurfacePainted(participantPage);
        await expect.poll(async () => (await currentCollaboration(participantPage))?.state.participants.length).toBe(3);
      }
      const first = (await currentCollaboration(page))!;
      const second = (await currentCollaboration(secondDevice))!;
      const readOnly = (await currentCollaboration(viewer))!;
      expect(new Set([first.participantId, second.participantId, readOnly.participantId]).size).toBe(3);
      expect(first.state.participants.find((participant) => participant.id === readOnly.participantId)?.canControl).toBe(false);
      expect(new Set(first.state.participants.map((participant) => participant.pageId)).size).toBe(1);
      expect(first.state.participants.every((participant) => Boolean(participant.pageId))).toBe(true);
      await expect(collaborationAction(viewer)).toHaveCount(0);
      await expect(sharedSurface(viewer)).toHaveAttribute("data-input-enabled", "false");
      expect(await inputSocketProbeSnapshot(viewer)).toEqual([]);
      await waitForOpenInputSocket(page);
      await waitForOpenInputSocket(secondDevice);
      await expectExistingInputAccepted(page, FIRST_TARGET);

      await expect(collaborationAction(secondDevice)).toHaveAttribute("data-action", "request");
      await collaborationAction(secondDevice).click();
      await expect(collaborationAction(secondDevice)).toBeDisabled();
      await expect.poll(async () => (await currentCollaboration(page))?.state.requests).toEqual([second.participantId]);
      await expect(collaborationAction(page)).toHaveAttribute("data-action", "grant");
      await collaborationAction(page).click();
      for (const participantPage of pages) {
        await expect.poll(async () => (await currentCollaboration(participantPage))?.state.controlOwner).toEqual({
          kind: "human", participantId: second.participantId,
        });
      }
      await expect(sharedSurface(page)).toHaveAttribute("data-input-enabled", "false");
      await expect(sharedSurface(secondDevice)).toHaveAttribute("data-input-enabled", "true");
      await expect(collaborationState(secondDevice)).toContainText("You control");
      // A former driver's already-open, normally authenticated input channel
      // must follow the handoff; matching account names confer no authority.
      await expectExistingInputRejected(page, FIRST_TARGET);
      await expectExistingInputAccepted(secondDevice, SECOND_TARGET);

      const disrupted = await disruptLatestCollaborationSocket(secondDevice);
      await expect(sharedSurface(secondDevice)).toHaveAttribute("data-input-enabled", "false", { timeout: 3_000 });
      await expect.poll(async () => {
        const connected = await currentCollaboration(secondDevice);
        return connected && {
          participantId: connected.participantId,
          entryCount: connected.entryCount,
          count: connected.state.participants.length,
          owner: connected.state.controlOwner,
        };
      }, { timeout: 9_000, message: "same device reconnects within the server's 10-second grace" }).toEqual({
        participantId: second.participantId,
        entryCount: disrupted.entryCount + 1,
        count: 3,
        owner: { kind: "human", participantId: second.participantId },
      });
      await expect(sharedSurface(secondDevice)).toHaveAttribute("data-input-enabled", "true");
      await expectExistingInputRejected(page, FIRST_TARGET);
      await expectExistingInputAccepted(secondDevice, SECOND_TARGET);

      await expect(collaborationAction(secondDevice)).toHaveAttribute("data-action", "release");
      await collaborationAction(secondDevice).click();
      for (const participantPage of pages) {
        await expect.poll(async () => (await currentCollaboration(participantPage))?.state.controlOwner).toBeNull();
        await expect(sharedSurface(participantPage)).toHaveAttribute("data-input-enabled", "false");
      }
      // View-only remains view-only even when control is available.
      await expect(collaborationAction(viewer)).toHaveCount(0);
      expect(await inputSocketProbeSnapshot(viewer)).toEqual([]);
      await expect(collaborationAction(page)).toHaveAttribute("data-action", "take");
      await collaborationAction(page).click();
      await expect(collaborationState(page)).toContainText("You control");
      await expect(sharedSurface(page)).toHaveAttribute("data-input-enabled", "true");
      await expectExistingInputAccepted(page, FIRST_TARGET);
      await expectExistingInputRejected(secondDevice, SECOND_TARGET);
    } finally {
      await secondDeviceContext?.close().catch(() => {});
      await viewerContext?.close().catch(() => {});
      if (viewerUserId) await deleteDisposableTestUser(viewerUserId);
    }
  });
});
