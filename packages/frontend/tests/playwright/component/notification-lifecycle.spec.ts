import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { NotificationEventName, NotificationPreferences, ProductNotification } from "../../../src/notifications/notificationContract";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__notification-lifecycle-fixture__";
const API_PATH = "/__notification-controller-fixture__";
const USER = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const TARGET = `/studio?supportReportId=${REPORT}`;

/** Browser interaction simulation only. Real PostgreSQL/worker/provider tests
 * separately prove transactions, concurrent producers, leases and permissions. */
class NotificationControllerFixture {
  items: ProductNotification[] = [];
  stateChanges: { id: string; action: string }[] = [];
  preferences: NotificationPreferences = {
    hidePreviews: true,
    preferences: ["support", "conversations", "runs", "automations"].flatMap((category) =>
      ["web_push", "apns", "local"].map((channel) => ({ category, channel, enabled: true }))) as NotificationPreferences["preferences"],
  };
  private resolved = false;
  private clock = Date.parse("2026-09-06T12:00:00Z");
  tick(): string { return new Date(this.clock += 1_000).toISOString(); }
  emit(eventName: NotificationEventName, seen = false): string {
    const id = `44444444-4444-4444-8444-${String(this.items.length + 1).padStart(12, "0")}`;
    const occurredAt = this.tick();
    const support = eventName.startsWith("support.");
    this.items.unshift({
      id, eventName, version: 1, category: support ? "support" : eventName === "run.failed" ? "runs" : "conversations",
      resourceType: support ? "support_report" : "conversation", resourceId: support ? REPORT : PROJECT,
      occurredAt, title: "PRIVATE_BACKEND_TEXT", body: "PRIVATE_BACKEND_TEXT",
      url: support ? TARGET : `/studio?projectId=${PROJECT}`,
      seenAt: seen ? occurredAt : null, readAt: null, archivedAt: null,
    });
    return id;
  }
  resolve(): string | null {
    if (this.resolved) return null;
    this.resolved = true;
    return this.emit("support.resolved");
  }
  reopen(): void { this.resolved = false; }
  async install(page: Page): Promise<void> {
    await page.route(`**${API_PATH}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.slice(API_PATH.length);
      expect(request.headers().authorization).toBe("Bearer notification-browser-fixture");
      const json = (body: unknown) => route.fulfill({ json: body });
      if (path === "/me/notifications" && request.method() === "GET") {
        const live = this.items.filter((item) => !item.archivedAt);
        const selected = live.filter((item) => url.searchParams.get("view") !== "unread" || !item.readAt);
        const offset = Number(url.searchParams.get("before") ?? 0);
        // Small server pages make actual browser pagination reachable in this fixture.
        const pageSize = Math.min(Number(url.searchParams.get("limit") ?? 25), 2);
        return json({ ok: true, items: selected.slice(offset, offset + pageSize), nextCursor: offset + pageSize < selected.length ? String(offset + pageSize) : null, unreadCount: live.filter((item) => !item.readAt).length, asOf: this.tick() });
      }
      if (path === "/me/notifications/state" && request.method() === "POST") {
        const body = request.postDataJSON() as { id: string; action: string };
        const item = this.items.find((item) => item.id === body.id);
        if (!item) return route.fulfill({ status: 404, json: { error: "Notification not found" } });
        this.stateChanges.push(body);
        item.seenAt ??= this.tick();
        if (body.action === "read" || body.action === "archive") item.readAt ??= this.tick();
        if (body.action === "archive") item.archivedAt ??= this.tick();
        return json({ ok: true });
      }
      if (path === "/me/notifications/read-all" && request.method() === "POST") {
        const { before } = request.postDataJSON() as { before: string };
        for (const item of this.items) if (item.occurredAt <= before) { item.seenAt ??= this.tick(); item.readAt ??= this.tick(); }
        return json({ ok: true });
      }
      if (path === "/me/notifications/preferences") {
        if (request.method() === "POST") {
          const body = request.postDataJSON() as Partial<NotificationPreferences>;
          if (typeof body.hidePreviews === "boolean") this.preferences.hidePreviews = body.hidePreviews;
          for (const preference of body.preferences ?? []) {
            const index = this.preferences.preferences.findIndex((item) => item.category === preference.category && item.channel === preference.channel);
            this.preferences.preferences[index] = preference;
          }
        }
        return json({ ok: true, ...this.preferences });
      }
      throw new Error(`Unexpected notification fixture request: ${request.method()} ${path}`);
    });
  }
}

async function mountCenter(page: Page): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const javascript = (body: string) => ({ contentType: "application/javascript", body });
  await page.route("**/src/services/runtimeController/core.ts*", (route) => route.fulfill(javascript(`
    export const runtimeControllerEnabled = true;
    export const controllerBaseUrl = location.origin + ${JSON.stringify(API_PATH)};
    export const resolveControllerRequestContext = async () => ({ baseUrl: controllerBaseUrl, accessToken: "notification-browser-fixture" });
    export const readControllerError = async (response, fallback) => (await response.json().catch(() => null))?.error ?? fallback;
  `)));
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill(javascript(`
    import * as notifications from "/src/services/runtimeController/productNotifications.ts";
    export const controllerClient = { notifications: {
      list: notifications.listProductNotifications, updateState: notifications.updateProductNotificationState,
      readAll: notifications.readAllProductNotifications, getPreferences: notifications.getProductNotificationPreferences,
      savePreferences: notifications.saveProductNotificationPreferences,
    }};
  `)));
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from ${JSON.stringify(deps.react)};
    import ReactDomClientNS from ${JSON.stringify(deps.reactDomClient)};
    import { useNotificationCenter } from "/src/notifications/useNotificationCenter.tsx";
    import { getNotificationSession, setNotificationSession } from "/src/notifications/notificationSession.ts";
    import { publishNotificationAccount, routeNotificationClick, NOTIFICATION_NAVIGATE_EVENT } from "/src/notifications/notificationPresentation.ts";
    import { processNotificationClickDestination } from "/src/notifications/notificationActions.ts";
    import { StatusProvider } from "/src/status/StatusProvider.tsx";
    import { Status } from "/src/status/Status.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    setNotificationSession({ userId: ${JSON.stringify(USER)}, accessToken: "notification-browser-fixture" });
    localStorage.setItem("instafy.notifications.enabled:" + ${JSON.stringify(USER)}, "1");
    await publishNotificationAccount(${JSON.stringify(USER)});
    // OS notification delivery is captured. Production center, privacy envelope,
    // account-scoped ledger and notification click validation still execute.
    window.__notificationSimulation = { foreground: true, displayed: [], click: (index) => routeNotificationClick(window.__notificationSimulation.displayed[index]) };
    window.instafyDesktop = { notify: async (payload) => { window.__notificationSimulation.displayed.push(payload); } };
    // Headless Chromium emulates focus for every page; model the OS focus signal
    // explicitly while all production foreground/background routing executes.
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => window.__notificationSimulation.foreground });
    function Fixture() {
      const [target, setTarget] = React.useState("");
      const navigate = React.useCallback((url) => { history.pushState({}, "", url); setTarget(url); }, []);
      React.useEffect(() => {
        const action = (event) => {
          // Use the same authenticated destination consumer as Studio. Receipt
          // alone does not acknowledge; opening the click destination does.
          history.pushState({}, "", event.detail.url);
          void processNotificationClickDestination({
            url: event.detail.url,
            userId: ${JSON.stringify(USER)},
            accessToken: "notification-browser-fixture",
            isCurrent: () => getNotificationSession()?.userId === ${JSON.stringify(USER)},
            openResource: setTarget,
          }).then((result) => {
            if (result.status === "opened") history.replaceState({}, "", result.resourceUrl);
          });
        };
        window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, action);
        return () => window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, action);
      }, [navigate]);
      const center = useNotificationCenter({ userId: ${JSON.stringify(USER)}, accessToken: "notification-browser-fixture", navigate });
      return h(React.Fragment, null,
        h("main", { className: "min-h-dvh bg-slate-50 text-slate-800" },
          h("header", { className: "flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3" },
            h("strong", { className: "text-base" }, "Instafy"), center.bell),
          h("section", { className: "mx-auto max-w-3xl p-6" },
            h("h1", { className: "text-xl font-semibold" }, "Your workspace"),
            h("p", { className: "mt-2 text-sm text-slate-500" }, "Support updates and project activity are available from the notification bell."),
            h("output", { "data-testid": "notification-target", className: "mt-6 block break-all text-xs text-slate-500" }, target))),
        center.dialog, h(Status));
    }
    createRoot(document.getElementById("root")).render(h(StatusProvider, null, h(Fixture)));
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>html,body,#root { margin:0; min-width:0; width:100%; min-height:100%; }</style>
    <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${FIXTURE_PATH}/main.js"></script></head><body><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(javascript(main)));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("notification-center-bell"), errors.join("; ")).toBeVisible();
  return errors;
}
async function poll(page: Page): Promise<void> { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }
async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}
async function centerFits(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Notifications", exact: true });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  const heading = dialog.getByRole("heading", { name: "Notifications", exact: true });
  expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow-phone", width: 360, height: 800 }]) {
  test(`simulates durable notification interactions on ${viewport.name}`, async ({ page, browser }, info) => {
    await page.setViewportSize(viewport);
    const controller = new NotificationControllerFixture();
    await controller.install(page);
    const errors = await mountCenter(page);
    await page.getByTestId("notification-center-bell").click();
    await expect(page.getByText("No notifications yet.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();

    // Simulate the OS reporting the page in the background.
    await page.evaluate(() => { (window as unknown as { __notificationSimulation: { foreground: boolean } }).__notificationSimulation.foreground = false; });
    const reply = controller.emit("support.reply");
    await poll(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __notificationSimulation: { displayed: unknown[] } }).__notificationSimulation.displayed.length)).toBe(1);
    const payload = await page.evaluate(() => (window as unknown as { __notificationSimulation: { displayed: Record<string, string>[] } }).__notificationSimulation.displayed[0]);
    expect(payload).toMatchObject({ eventId: reply, accountId: USER, title: "Instafy", body: "You have a new notification.", url: TARGET });

    const deviceContext = await browser.newContext({ viewport, baseURL: "http://127.0.0.1:5206" });
    const device = await deviceContext.newPage();
    await controller.install(device);
    const deviceErrors = await mountCenter(device);
    await expect(device.getByTestId("notification-center-unread")).toHaveText("1");
    expect(controller.items.find((item) => item.id === reply)?.readAt).toBeNull();
    await page.bringToFront();
    await page.evaluate(() => (window as unknown as { __notificationSimulation: { click: (index: number) => boolean } }).__notificationSimulation.click(0));
    await expect(page.getByTestId("notification-target")).toHaveText(TARGET);
    expect(new URL(page.url()).searchParams.get("supportReportId")).toBe(REPORT);
    await expect.poll(() => controller.items.find((item) => item.id === reply)?.readAt).not.toBeNull();
    expect(controller.stateChanges.filter((change) => change.id === reply && change.action === "read")).toHaveLength(1);
    await page.evaluate(() => { (window as unknown as { __notificationSimulation: { foreground: boolean } }).__notificationSimulation.foreground = true; });
    await poll(device);
    await expect(device.getByTestId("notification-center-unread")).toHaveCount(0);

    const firstResolution = controller.resolve()!;
    expect(controller.resolve()).toBeNull();
    await poll(page);
    const resolutionToast = page.getByTestId("status-toast").filter({ hasText: "Your support report has been resolved." });
    await expect(resolutionToast).toHaveCount(1);
    await resolutionToast.getByRole("button", { name: "View", exact: true }).click();
    await expect(page.getByTestId("notification-target")).toHaveText(TARGET);
    controller.reopen();
    const secondResolution = controller.resolve()!;
    expect(secondResolution).not.toBe(firstResolution);
    await poll(page);
    await expect(resolutionToast).toHaveCount(1);
    await resolutionToast.getByRole("button", { name: "Dismiss notification" }).click();
    await page.getByTestId("notification-center-bell").click();
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.getByTestId(`notification-${reply}`)).toBeVisible();
    await poll(page);
    await expect(page.getByTestId(`notification-${reply}`)).toBeVisible();
    await centerFits(page);
    await capture(page, info, "notification-center-all");

    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(page.getByTestId(`notification-${reply}`)).toHaveCount(0);
    await expect(page.getByTestId(`notification-${firstResolution}`)).toHaveCount(0);
    await page.getByTestId(`notification-${secondResolution}`).getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByTestId("notification-center-unread")).toHaveCount(0);
    await expect(page.getByText("You're all caught up.", { exact: true })).toBeVisible();

    controller.emit("run.failed", true);
    controller.emit("conversation.reply", true);
    await poll(page);
    await expect(page.getByTestId("notification-center-unread")).toHaveText("2");
    await page.getByRole("button", { name: "Mark all read", exact: true }).click();
    await expect(page.getByTestId("notification-center-unread")).toHaveCount(0);
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    // Preferences are server-confirmed controlled inputs; await the HTTP result
    // rather than requiring an optimistic checkbox state during the click.
    await page.getByRole("checkbox", { name: "Hide lock-screen previews", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Hide lock-screen previews", exact: true })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Support Browser push", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Support Browser push", exact: true })).not.toBeChecked();
    expect(controller.preferences.hidePreviews).toBe(false);
    expect(controller.preferences.preferences.find((item) => item.category === "support" && item.channel === "web_push")?.enabled).toBe(false);
    await centerFits(page);
    await capture(page, info, "notification-center-preferences");
    await expect(page.getByText("PRIVATE_BACKEND_TEXT", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Inbox", exact: true }).click();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByTestId("notification-center-bell").click();
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Hide lock-screen previews", exact: true })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Support Browser push", exact: true })).not.toBeChecked();
    expect(controller.items.filter((item) => item.eventName === "support.resolved")).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(deviceErrors).toEqual([]);
    await deviceContext.close();
  });
}

test("reads only source messages exposed in the real browser viewport", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const deps = await resolveViteReactDependencies(page);
  const fixturePath = "/__conversation-read-fixture__";
  const messageIds = Array.from({ length: 4 }, (_, index) => `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`);
  const requests: { conversationId: string; messageIds: string[]; expectedUserId: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`**${API_PATH}/me/notifications/conversation-read`, async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer conversation-read-fixture");
    const body = route.request().postDataJSON();
    expect(body.conversationId).toBe(PROJECT);
    expect(body.expectedUserId).toBe(USER);
    expect(body.messageIds.length).toBeLessThanOrEqual(100);
    requests.push(body);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/src/services/runtimeController/core.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: `
    export const runtimeControllerEnabled = true;
    export const controllerBaseUrl = location.origin + ${JSON.stringify(API_PATH)};
    export const resolveControllerRequestContext = async (accessToken) => ({ baseUrl: controllerBaseUrl, accessToken });
    export const readControllerError = async (_response, fallback) => fallback;
  ` }));
  const main = `
    import ReactNS from ${JSON.stringify(deps.react)};
    import ReactDomClientNS from ${JSON.stringify(deps.reactDomClient)};
    import { useConversationNotificationRead } from "/src/notifications/useConversationNotificationRead.ts";
    import { setNotificationSession } from "/src/notifications/notificationSession.ts";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    setNotificationSession({ userId: ${JSON.stringify(USER)}, accessToken: "conversation-read-fixture" });
    const sourceIds = ${JSON.stringify(messageIds)};
    function Fixture() {
      const rootRef = React.useRef(null);
      const [covered, setCovered] = React.useState(true);
      const [hidden, setHidden] = React.useState(false);
      const [count, setCount] = React.useState(3);
      useConversationNotificationRead({ currentUserId: ${JSON.stringify(USER)}, conversationId: ${JSON.stringify(PROJECT)}, rootRef });
      return h("main", null,
        h("h1", null, "Conversation visibility simulation"),
        h("button", { onClick: () => setHidden((value) => !value), "data-testid": "toggle-chat" }, hidden ? "Show chat" : "Hide chat"),
        h("button", { onClick: () => setCount(4), "data-testid": "append-message" }, "Receive another message"),
        h("section", { hidden, style: { marginTop: 20 } },
          h("div", { ref: rootRef, tabIndex: 0, "data-testid": "read-transcript", style: { height: 180, overflowY: "auto", border: "1px solid #94a3b8" } },
            ...sourceIds.slice(0, count).map((id, index) => h("article", {
              key: id, "data-chat-message-id": id,
              style: { boxSizing: "border-box", height: 200, padding: 18, borderBottom: "1px solid #e2e8f0", background: "white" },
            }, "Persisted source message " + (index + 1))),
          ),
        ),
        covered ? h("div", { style: { position: "fixed", inset: 0, zIndex: 100, background: "#f1f5f9", padding: 24 } },
          h("h2", null, "Another app dialog covers chat"),
          h("button", { "data-testid": "uncover-chat", onClick: () => { setCovered(false); requestAnimationFrame(() => rootRef.current?.focus()); } }, "Return to chat"),
        ) : null,
      );
    }
    createRoot(document.getElementById("root")).render(h(React.StrictMode, null, h(Fixture)));
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body { margin:16px; font:14px system-ui; background:#f8fafc; } h1 { font-size:20px; } button { padding:10px; margin:4px; }</style>
    <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${fixturePath}/main.js"></script></head><body><div id="root"></div></body></html>`;
  await page.route(`**${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${fixturePath}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(fixturePath);
  await expect(page.getByTestId("uncover-chat")).toBeVisible();
  // Dwell beyond the production 250ms coalescing window: an intersecting
  // transcript beneath this opaque modal must remain unread.
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
  await page.getByTestId("uncover-chat").click();
  await expect.poll(() => requests.flatMap((request) => request.messageIds)).toEqual([messageIds[0]]);
  const transcript = page.getByTestId("read-transcript");
  await transcript.evaluate((element) => { element.scrollTop = 200; });
  await expect.poll(() => requests.flatMap((request) => request.messageIds)).toEqual(messageIds.slice(0, 2));
  await page.getByTestId("append-message").click();
  await page.waitForTimeout(500);
  expect(requests.flatMap((request) => request.messageIds)).toEqual(messageIds.slice(0, 2));
  await page.getByTestId("toggle-chat").click();
  await expect(transcript).toBeHidden();
  await transcript.evaluate((element) => { element.scrollTop = 400; });
  await page.waitForTimeout(500);
  expect(requests.flatMap((request) => request.messageIds)).toEqual(messageIds.slice(0, 2));
  await page.getByTestId("toggle-chat").click();
  await transcript.evaluate((element) => { element.scrollTop = 400; });
  await expect.poll(() => requests.flatMap((request) => request.messageIds)).toEqual(messageIds.slice(0, 3));
  await capture(page, info, "conversation-visible-source-read");
  expect(requests.flatMap((request) => request.messageIds)).not.toContain(messageIds[3]);
  expect(errors).toEqual([]);
});
