import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type {
  ControllerBugReportDetail,
  ControllerBugReportMessage,
} from "../../../src/services/runtimeController/bugReports";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__support-lifecycle-fixture__";
const CONTROLLER_PATH = "/__support-controller-fixture__";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const DESCRIPTION = "The preview stays blank after saving my project.";

/**
 * In-memory controller contract for browser interaction, not backend proof.
 * The companion PostgreSQL lifecycle/privacy tests prove real persistence and
 * ownership. This fixture exercises real HTTP serialization and all customer
 * components without loading real account credentials or a controller.
 */
class SupportControllerFixture {
  report: ControllerBugReportDetail | null = null;
  messages: ControllerBugReportMessage[] = [];
  submissions: Record<string, unknown>[] = [];
  replies: Record<string, unknown>[] = [];
  acknowledgements: string[] = [];
  claims = 0;
  pendingResolution = false;
  requests: string[] = [];
  olderReportCount = 0;
  private clock = Date.parse("2026-09-05T12:00:00Z");
  private timelineGate: Promise<void> | null = null;
  private releaseTimelineGate: (() => void) | null = null;

  tick(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  holdTimeline(): void {
    this.timelineGate = new Promise((resolve) => { this.releaseTimelineGate = resolve; });
  }

  releaseTimeline(): void {
    this.releaseTimelineGate?.();
    this.timelineGate = null;
    this.releaseTimelineGate = null;
  }

  publishSupportReply(body: string): void {
    if (!this.report) throw new Error("Create a report before publishing a reply");
    const createdAt = this.tick();
    this.messages.push({ id: `support-${createdAt}`, authorType: "support", body, createdAt });
    Object.assign(this.report, {
      status: "waiting_for_customer",
      activityAt: createdAt,
      updatedAt: createdAt,
      supportLastMessageAt: createdAt,
      hasUnreadSupportActivity: true,
    });
  }

  resolve(): void {
    if (!this.report || this.report.status === "resolved") {
      throw new Error("Resolution requires a non-resolved report");
    }
    const createdAt = this.tick();
    Object.assign(this.report, {
      status: "resolved",
      resolvedAt: createdAt,
      supportLastMessageAt: createdAt,
      activityAt: createdAt,
      updatedAt: createdAt,
      hasUnreadSupportActivity: true,
      hasUnreadResolution: true,
    });
    this.messages.push({
      id: `resolved-${createdAt}`, authorType: "system",
      body: "Support marked this report resolved.", createdAt,
    });
    this.pendingResolution = true;
  }

  async install(page: Page): Promise<void> {
    await page.route(`**${CONTROLLER_PATH}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname.slice(CONTROLLER_PATH.length);
      const method = request.method();
      this.requests.push(`${method} ${pathname}`);
      expect(request.headers().authorization).toBe("Bearer support-browser-fixture");
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (pathname === "/support/reports" && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        expect(body.expectedUserId).toBe(USER_ID);
        expect(body.clientRequestId).toEqual(expect.any(String));
        this.submissions.push(body);
        const createdAt = this.tick();
        this.report = {
          id: REPORT_ID, message: String(body.message), details: String(body.details),
          createdAt, activityAt: createdAt, updatedAt: createdAt, status: "open",
          projectId: null, screenshots: [], customerLastMessageAt: createdAt,
          supportLastMessageAt: null, resolvedAt: null,
          hasUnreadSupportActivity: false, hasUnreadResolution: false,
        };
        this.messages = [];
        return json({ id: REPORT_ID, createdAt }, 201);
      }
      if (pathname === "/support/reports" && method === "GET") {
        expect(url.searchParams.get("expected_user_id")).toBe(USER_ID);
        return json({
          reports: this.report ? [
            { ...this.report, screenshotCount: 0 },
            ...Array.from({ length: this.olderReportCount }, (_, index) => ({
              ...this.report,
              id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
              message: `Older support report ${index + 1}`,
              status: "open", screenshotCount: 0,
              hasUnreadSupportActivity: false, hasUnreadResolution: false,
            })),
          ] : [],
          hasMore: false, nextCursor: null,
          unreadCount: Number(this.report?.hasUnreadSupportActivity ?? false),
          unreadResolutionCount: Number(this.report?.hasUnreadResolution ?? false),
          unnotifiedResolutionCount: Number(this.pendingResolution),
        });
      }
      if (pathname === "/support/resolution-alerts/claim" && method === "POST") {
        expect(request.postDataJSON()).toEqual({ expectedUserId: USER_ID });
        const claimed = this.pendingResolution;
        this.pendingResolution = false;
        if (claimed) this.claims += 1;
        return json({
          claimedCount: Number(claimed),
          latestReportId: claimed ? this.report?.id : null,
          latestResolvedAt: claimed ? this.report?.resolvedAt : null,
        });
      }
      if (pathname === `/support/reports/${REPORT_ID}` && method === "GET") {
        return json(this.report);
      }
      if (pathname === `/support/reports/${REPORT_ID}/messages` && method === "GET") {
        await this.timelineGate;
        return json({ messages: this.messages, hasMore: false, nextCursor: null });
      }
      if (pathname === `/support/reports/${REPORT_ID}/messages` && method === "POST") {
        if (!this.report) throw new Error("Missing report");
        const body = request.postDataJSON() as Record<string, unknown>;
        this.replies.push(body);
        expect(body.clientRequestId).toEqual(expect.any(String));
        const createdAt = this.tick();
        const message: ControllerBugReportMessage = {
          id: String(body.clientRequestId), authorType: "customer", body: String(body.body), createdAt,
        };
        this.messages.push(message);
        Object.assign(this.report, {
          status: this.report.status === "resolved" ? "open" : this.report.status,
          resolvedAt: this.report.status === "resolved" ? null : this.report.resolvedAt,
          customerLastMessageAt: createdAt,
          activityAt: createdAt, updatedAt: createdAt,
        });
        return json({ message });
      }
      if (pathname === `/support/reports/${REPORT_ID}/acknowledge` && method === "POST") {
        if (!this.report) throw new Error("Missing report");
        const body = request.postDataJSON() as { seenThrough: string };
        this.acknowledgements.push(body.seenThrough);
        const unread = Date.parse(this.report.supportLastMessageAt!) > Date.parse(body.seenThrough);
        this.report.hasUnreadSupportActivity = unread;
        this.report.hasUnreadResolution = unread && this.report.status === "resolved";
        return json({
          acknowledgedThrough: body.seenThrough,
          hasUnreadSupportActivity: this.report.hasUnreadSupportActivity,
          hasUnreadResolution: this.report.hasUnreadResolution,
        });
      }
      throw new Error(`Unexpected support fixture request: ${method} ${pathname}`);
    });
  }
}

async function mountSupport(page: Page): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const javascript = (body: string) => ({ contentType: "application/javascript", body });
  // Preserve the production HTTP parser/serializer. Replace only its authority
  // resolver with an inert browser fixture identity and a same-origin endpoint.
  await page.route("**/src/services/runtimeController/core.ts*", (route) => route.fulfill(javascript(`
    export const runtimeControllerEnabled = true;
    export const resolveControllerRequestContext = async () => ({
      baseUrl: location.origin + ${JSON.stringify(CONTROLLER_PATH)}, accessToken: "support-browser-fixture"
    });
    export const readControllerError = async (response, fallback) =>
      (await response.json().catch(() => null))?.error ?? fallback;
  `)));
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill(javascript(`
    import * as support from "/src/services/runtimeController/bugReports.ts";
    export const controllerClient = { bugReports: {
      submit: support.submitControllerBugReport,
      createRequestId: support.createControllerBugReportRequestId,
      get: support.getControllerBugReport,
      acknowledgeActivity: support.acknowledgeControllerBugReportActivity,
      claimResolutionAlerts: support.claimControllerSupportResolutionAlerts,
      listPage: support.listControllerBugReportPage,
      listMessagePage: support.listControllerBugReportMessagePage,
      postMessage: support.postControllerBugReportMessage,
      createMessageRequestId: support.createControllerBugReportMessageRequestId
    }};
  `)));
  // Native updater discovery is irrelevant to the browser support lifecycle.
  await page.route("**/src/updates/releaseMetadata.ts*", (route) => route.fulfill(javascript(`
    export const collectAppReleaseMetadata = async () => null;
    export const buildReleaseMetadataDetailRows = () => [];
    export const summarizeAppUpdateState = () => ({ title: "Fixture", detail: "", show: false });
  `)));
  await page.route("**/src/config/buildInfo.ts*", (route) => route.fulfill(javascript(`
    export const instafyBuildInfo = { packageVersion: "fixture", gitCommitShort: "fixture" };
  `)));

  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from ${JSON.stringify(deps.react)};
    import ReactDomClientNS from ${JSON.stringify(deps.reactDomClient)};
    import { useStudioBugReportController } from "/src/screens/studio/components/useStudioBugReportController.tsx";
    import { StudioSidebarAccountSection } from "/src/screens/studio/components/StudioSidebarAccountSection.tsx";
    import { StatusProvider } from "/src/status/StatusProvider.tsx";
    import { Status } from "/src/status/Status.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const noop = () => {};
    function Fixture() {
      const [profileMenuOpen, setProfileMenuOpen] = React.useState(false);
      const footerRef = React.useRef(null);
      const support = useStudioBugReportController({
        currentUserId: ${JSON.stringify(USER_ID)}, activeProjectId: null,
        activeConversationId: null, activeConversationLocalId: null,
        activeRuntimeId: null, controllerProjectMissing: false, buildLogs: []
      });
      return h(React.Fragment, null,
        h("main", { className: "flex min-h-dvh flex-col justify-end bg-slate-50 p-4" },
          h("div", { className: "w-64 max-w-full" },
            h(StudioSidebarAccountSection, {
              footerRef, showLabels: true, collapsedSidebarDensity: "comfortable",
              profileMenuOpen, onProfileMenuOpenChange: setProfileMenuOpen,
              avatarUrl: null, initials: "ST", displayName: "Support Tester",
              accountSubtitle: "support@example.test", resolvedTheme: "light",
              onThemeModeChange: noop, showInstallEntry: false, shouldRenderUpdateEntry: false,
              updatePresentation: null, onUpdateEntryClick: noop, onUpdateEntryContextMenu: noop,
              onUpdateEntryPointerDown: noop, clearUpdateLongPress: noop,
              onOpenSupport: support.onOpenBugReportInbox, supportUnreadCount: support.supportUnreadCount,
              notificationsPending: false, notificationsEnabled: false, onToggleNotifications: noop,
              onOpenDiagnostics: noop, hasAppLogErrors: false, updateDialogOpen: false,
              onUpdateDialogOpenChange: noop, updateMetadata: null, updateDialogShowDetails: false,
              onUpdateDialogShowDetailsChange: noop, onUpdatePrimaryAction: noop, updateActionPending: false,
            }),
          ),
        ),
        support.dialogs,
        h(Status),
      );
    }
    createRoot(document.getElementById("root")).render(
      h(React.StrictMode, null, h(StatusProvider, null, h(Fixture))),
    );
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <style>html, body, #root { margin: 0; min-width: 0; width: 100%; min-height: 100%; }</style>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(javascript(main)));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("sidebar-profile-menu"), errors.join("; ")).toBeVisible();
  return errors;
}

async function openSupport(page: Page): Promise<void> {
  await page.getByTestId("sidebar-profile-menu").click();
  await page.getByTestId("profile-support-button").click();
  await expect(page.getByRole("dialog", { name: "Support", exact: true })).toBeVisible();
}

async function expectSupportHeaderUsable(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Support", exact: true });
  const heading = dialog.getByRole("heading", { name: "Support", exact: true });
  const titleGeometry = await heading.evaluate((element) => ({
    visibleWidth: element.clientWidth,
    contentWidth: element.scrollWidth,
  }));
  expect(titleGeometry.visibleWidth, "The Support title must not be clipped by header actions")
    .toBeGreaterThanOrEqual(titleGeometry.contentWidth);
  const description = dialog.getByText(
    "Your private support reports across all spaces. Only you and authorized support can see them.",
    { exact: true },
  );
  const box = await description.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width, "The privacy description must remain readable, not a one-word column")
    .toBeGreaterThanOrEqual(Math.min(200, page.viewportSize()!.width / 2));
  await expectReachable(page, dialog.getByRole("button", { name: "Close support", exact: true }));
}

async function pollOnFocus(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function expectReachable(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await locator.click({ trial: true });
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow-phone", width: 360, height: 800 },
]) {
  test(`plays out the support lifecycle on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const controller = new SupportControllerFixture();
    await controller.install(page);
    const errors = await mountSupport(page);
    await openSupport(page);
    await expectSupportHeaderUsable(page);
    await expect(page.getByText("No support reports yet", { exact: true })).toBeVisible();
    await expectReachable(page, page.getByTestId("support-new-report"));
    await page.getByTestId("support-new-report").click();
    await page.getByTestId("bug-report-description").fill(DESCRIPTION);
    await page.getByTestId("bug-report-submit").click();
    await expect(page.getByTestId("bug-report-modal")).toBeHidden();
    expect(controller.submissions).toHaveLength(1);
    expect(controller.submissions[0]).toMatchObject({
      message: DESCRIPTION, details: DESCRIPTION, metadata: {}, logs: [], screenshots: [],
    });

    // A real inbox accumulates reports. Keep the active conversation usable
    // when the list needs to scroll, including on a narrow phone.
    controller.olderReportCount = 20;
    await openSupport(page);
    await expect(page.getByTestId("support-report-detail-status")).toHaveText("Received");
    await expect(page.getByTestId("support-message-timeline")).toContainText(DESCRIPTION);
    const detailPane = await page.getByTestId("support-reply").evaluate((element) => {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).overflowY === "auto") {
          return { height: ancestor.clientHeight, width: ancestor.clientWidth };
        }
      }
      return { height: 0, width: 0 };
    });
    expect(detailPane.height, "The report list must leave space to read the active conversation")
      .toBeGreaterThanOrEqual(180);
    expect(detailPane.width, "The conversation must not be squeezed into a narrow desktop column")
      .toBeGreaterThanOrEqual(Math.min(300, viewport.width - 64));
    await page.getByTestId("support-reply").fill("This also happens after a refresh.");
    await expectReachable(page, page.getByTestId("support-reply-submit"));
    await page.getByTestId("support-reply-submit").click();
    await expect(page.getByTestId("support-message-timeline")).toContainText("This also happens after a refresh.");
    expect(controller.replies).toHaveLength(1);
    await page.getByRole("button", { name: "Close support", exact: true }).click();

    controller.publishSupportReply("We reproduced this. Please try the updated preview.");
    await pollOnFocus(page);
    await expect(page.getByTestId("profile-support-indicator")).toBeVisible();
    await page.getByTestId("sidebar-profile-menu").click();
    await expect(page.getByTestId("profile-support-unread-count")).toHaveText("1");
    await page.getByTestId("profile-support-button").click();
    await expect(page.getByTestId("support-report-detail-status")).toHaveText("Waiting for you");
    await expect(page.getByTestId("support-message-timeline")).toContainText("We reproduced this.");
    await expect.poll(() => controller.acknowledgements.length).toBe(1);
    await expect(page.getByTestId("profile-support-indicator")).toHaveCount(0);
    await page.getByRole("button", { name: "Close support", exact: true }).click();

    controller.resolve();
    controller.holdTimeline();
    await pollOnFocus(page);
    const resolvedToast = page.getByTestId("status-toast").filter({ hasText: "Your Instafy support report was resolved." });
    await expect(resolvedToast).toBeVisible();
    await expect(page.getByTestId("profile-support-indicator")).toBeVisible();
    await expectReachable(page, resolvedToast.getByRole("button", { name: "View report" }));
    await capture(page, testInfo, "resolution-alert");
    await resolvedToast.getByRole("button", { name: "View report" }).click();
    await expect(page.getByTestId("support-report-detail-status")).toHaveText("Resolved");
    // Opening a dialog alone cannot clear the durable unread state: the current
    // timeline must finish loading and become visible first.
    expect(controller.acknowledgements).toHaveLength(1);
    expect(controller.report?.hasUnreadSupportActivity).toBe(true);
    controller.releaseTimeline();
    await expect(page.getByTestId("support-message-timeline")).toContainText("Support marked this report resolved.");
    await expect.poll(() => controller.acknowledgements.length).toBe(2);
    await expect(page.getByTestId("profile-support-indicator")).toHaveCount(0);
    expect(controller.claims).toBe(1);
    await capture(page, testInfo, "resolved-timeline");
    await page.getByTestId("support-reply").scrollIntoViewIfNeeded();
    await capture(page, testInfo, "resolved-conversation");

    await page.getByTestId("support-reply").fill("It still happens on a second project.");
    await expect(page.getByTestId("support-reply-submit")).toHaveText("Reply and reopen");
    await expectReachable(page, page.getByTestId("support-reply-submit"));
    await page.getByTestId("support-reply-submit").click();
    await expect(page.getByTestId("support-report-detail-status")).toHaveText("Received");
    await expect(page.getByTestId("support-message-timeline")).toContainText("It still happens on a second project.");
    await page.getByRole("button", { name: "Close support", exact: true }).click();

    controller.resolve();
    await pollOnFocus(page);
    await expect(resolvedToast).toBeVisible();
    expect(controller.claims).toBe(2);
    await resolvedToast.getByRole("button", { name: "View report" }).click();
    await expect(page.getByTestId("support-report-detail-status")).toHaveText("Resolved");
    await expect.poll(() => controller.acknowledgements.length).toBe(3);
    await expect(page.getByTestId("profile-support-indicator")).toHaveCount(0);
    await page.getByRole("button", { name: "Close support", exact: true }).click();
    await pollOnFocus(page);
    await expect(resolvedToast).toHaveCount(0);
    expect(controller.claims).toBe(2);
    expect(controller.replies).toHaveLength(2);
    expect(controller.replies[0].clientRequestId).not.toBe(controller.replies[1].clientRequestId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(errors, errors.join("; ")).toEqual([]);
  });
}
