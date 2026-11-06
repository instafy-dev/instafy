import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__toast-view-bar-clearance__";

type Layout = "desktop" | "desktop-sidebar" | "desktop-sidebar-people" | "phone" | "phone-file" | "desktop-browser" | "phone-browser" | "desktop-browser-starting";

/**
 * Studio's header and its Chat | Browser bar as the real components draw
 * them, with the real toast region. Desktop: the open chats' tab strip, then
 * the view bar. Phone: the page header, with the view bar beside the composer
 * in a chat, or under the header on a chat's file. In the Browser view, the
 * browser's own bar with its address comes under them. With the sidebar, the
 * chat is Studio's workspace beside it, which toasts sit over, and the
 * participants drawer lies over the workspace's right edge.
 */
async function mount(page: Page, layout: Layout) {
  const deps = await resolveViteReactDependencies(page);
  // The Browser view as it starts: stub only the controller boundaries.
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "export const controllerClient = { core: { enabled: false } };",
  }));
  await page.route("**/src/services/runtimeController/origins.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "export async function requestOriginAccessToken() { throw new Error('No runtime in the layout fixture'); }",
  }));
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from ${JSON.stringify(deps.react)};
    import ReactDomClientNS from ${JSON.stringify(deps.reactDomClient)};
    import { StatusProvider } from "/src/status/StatusProvider.tsx";
    import { Status } from "/src/status/Status.tsx";
    import { useStatus } from "/src/status/useStatus.tsx";
    import { useToastAreaRef, useToastEdgePanelRef } from "/src/status/toastClearance.ts";
    import { ConversationSurfaceTabs } from "/src/workspace/ConversationSurfaceLayout.tsx";
    import { ConversationQuickTabs } from "/src/workspace/ConversationQuickTabs.tsx";
    import { BrowserChromeShell } from "/src/screens/studio/components/BrowserChromeShell.tsx";
    import { BrowserSessionModal } from "/src/screens/studio/components/BrowserSessionModal.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const layout = ${JSON.stringify(layout)};
    const starting = layout === "desktop-browser-starting";
    const browser = layout.endsWith("-browser") || starting;
    const views = (presentation) => h(ConversationSurfaceTabs, {
      presentation, chatPanelId: "chat-panel", activeId: layout === "phone-file" ? "file:notes.md" : browser ? "browser" : "chat",
      resourceId: "browser", split: false, wide: false, ratio: 0.55, onSelect: () => {}, onSplitChange: () => {},
      resources: [
        { id: "browser", label: "Browser", panelId: "browser-panel", attention: h("span", { className: "text-amber-600" }, "Approve") },
        ...(layout === "phone-file" ? [{ id: "file:notes.md", label: "notes.md", panelId: "file-panel" }] : []),
      ],
    });
    const chats = [
      { id: "porto", title: "Open visitporto.travel in your browser" },
      { id: "seville", title: "Plan 3 days in Seville for a first visit" },
    ];
    // The shared browser's own bar, once its controls have loaded.
    const chrome = {
      compact: false, resolved: true, pendingAction: null, error: null,
      pages: [{ id: "page-1", url: "https://httpbin.org/forms/post", host: "httpbin.org", label: "httpbin.org", title: "httpbin.org", isActive: true }],
      onNavigate: () => {}, onBack: () => {}, onForward: () => {}, onReload: () => {}, onFocusPage: () => {}, onClearError: () => {},
    };
    function StartingBrowserView() {
      const [controls, setControls] = React.useState(null);
      window.__browserControlsLoaded = () => setControls(chrome);
      return h(BrowserSessionModal, {
        isOpen: true, onOpenChange: () => {}, presentation: "docked", fillContainer: true, projectId: null, preferRuntimeId: null,
        sharedBrowserViewerKind: "cdp-screencast", sharedBrowserAvailableViewerKinds: ["cdp-screencast"],
        sharedBrowserChrome: controls,
      });
    }
    // Studio's workspace, right of its navigation, as StudioLayout registers it.
    function Workspace({ children }) {
      const ref = useToastAreaRef(true);
      return h("div", { ref, className: "relative flex min-w-0 flex-1 flex-col", "data-testid": "studio-workspace" }, children);
    }
    // The participants drawer, over the workspace's right edge, as ParticipantsDrawer registers it.
    function PeopleDrawer() {
      const ref = useToastEdgePanelRef(true);
      return h("aside", { ref, "data-testid": "participants-drawer",
        className: "absolute right-0 top-0 bottom-0 z-30 w-[300px] max-w-[85vw] border-l border-slate-200 bg-white p-3 text-sm" },
        "In this conversation");
    }
    function Fixture() {
      const { showStatus } = useStatus();
      window.__showReplyToast = () => showStatus("There is a new reply in “Plan 3 days in Seville for a first…”.", "info", 0,
        { actionLabel: "View", onAction: () => {}, nonPreemptive: true });
      window.__showWarningToast = () => showStatus("The agent is saving right now. Try again in a moment.", "warning", 0);
      const header = layout.startsWith("desktop")
        ? h("div", { className: "flex h-12 items-end px-4" }, h(ConversationQuickTabs, {
            tabs: chats, activeId: "porto", scopeName: "Porto weekend", onSelect: () => {}, onClose: () => {}, onKeep: () => {} }))
        : h("header", { className: "flex h-14 shrink-0 items-center px-4 text-sm font-semibold" }, "Open visitporto.travel in your…");
      const besideComposer = layout === "phone" || layout === "phone-browser";
      // The Browser view's own bar, as the shared browser draws it: its
      // address, on the page the turn left open.
      const browserBar = starting ? h("div", { className: "flex min-h-0 flex-1 flex-col", "data-testid": "starting-browser-view" }, h(StartingBrowserView))
        : browser ? h(BrowserChromeShell, {
        label: "Shared browser controls", testId: "browser-view-bar", navigation: null,
        address: h("input", { "aria-label": "Address", readOnly: true, value: "https://httpbin.org/forms/post",
          className: "h-8 w-full min-w-0 rounded-full border border-slate-200 px-3 text-sm" }),
      }) : null;
      const chat = [
        header,
        besideComposer ? null : views("header"),
        browserBar,
        starting ? null : h("main", { id: "chat-panel", className: "min-h-0 flex-1 overflow-hidden p-4 text-sm" }, "Octo wants to click “Edit” on en.metrodoporto.pt."),
        h("div", { className: "m-3 rounded-2xl border border-slate-200 p-2" },
          besideComposer ? views("composer") : null,
          h("div", { className: "px-2 py-2 text-sm text-slate-400" }, "Ask for something…")),
      ];
      if (layout.startsWith("desktop-sidebar")) {
        return h("div", { className: "flex h-dvh bg-white text-slate-800" },
          h("nav", { "data-testid": "sidebar", className: "w-[304px] shrink-0 border-r border-slate-200 p-3 text-sm" }, "Chats"),
          h(Workspace, null, ...chat, layout === "desktop-sidebar-people" ? h(PeopleDrawer) : null),
          h(Status));
      }
      return h("div", { className: "flex h-dvh flex-col bg-white text-slate-800" }, ...chat, h(Status));
    }
    createRoot(document.getElementById("root")).render(h(StatusProvider, null, h(Fixture)));
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>html,body,#root { margin:0; min-width:0; width:100%; min-height:100%; }</style>
    <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${FIXTURE_PATH}/main.js"></script></head><body><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("conversation-subtabs"), errors.join("; ")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

// At 1024×768 the reply toast "There is a new reply in “Plan 3 days in Seville
// for a first…”." covered the Chat | Browser switcher while it showed.
for (const { layout, width, height } of [
  { layout: "desktop" as const, width: 1024, height: 768 },
  { layout: "phone" as const, width: 375, height: 812 },
  { layout: "phone-file" as const, width: 375, height: 812 },
]) {
  test(`a toast leaves the Chat | Browser bar clear (${layout}, ${width}×${height})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors = await mount(page, layout);
    await page.evaluate(() => (window as unknown as { __showReplyToast: () => void }).__showReplyToast());
    const toast = page.getByTestId("status-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("There is a new reply in");
    const toastBox = (await toast.boundingBox())!;
    const barBox = (await page.getByTestId("conversation-subtabs").boundingBox())!;
    const overlaps = toastBox.y < barBox.y + barBox.height && barBox.y < toastBox.y + toastBox.height;
    expect(overlaps, `toast ${JSON.stringify(toastBox)} over bar ${JSON.stringify(barBox)}`).toBe(false);
    // Still a toast at the top of the screen, not anywhere else.
    expect(toastBox.y).toBeLessThan(height / 3);
    // Both stay pressable: the bar's tabs are not under the toast.
    await page.getByRole("tab", { name: "Browser, approval needed" }).click({ trial: true });
    expect(errors).toEqual([]);
  });
}

// A local test, Nov 2: the toast "Octo is waiting for your OK in “Open
// httpbin.org in your browser, fill…”." left Chat | Browser clear, but in the
// Browser view it covered the address bar.
for (const { layout, width, height } of [
  { layout: "desktop-browser" as const, width: 1024, height: 768 },
  { layout: "phone-browser" as const, width: 375, height: 812 },
]) {
  test(`a toast leaves the Browser view's address bar clear (${layout}, ${width}×${height})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors = await mount(page, layout);
    await page.evaluate(() => (window as unknown as { __showReplyToast: () => void }).__showReplyToast());
    const toast = page.getByTestId("status-toast");
    await expect(toast).toBeVisible();
    const toastBox = (await toast.boundingBox())!;
    for (const testId of ["browser-view-bar", "conversation-subtabs"]) {
      const barBox = (await page.getByTestId(testId).boundingBox())!;
      const overlaps = toastBox.y < barBox.y + barBox.height && barBox.y < toastBox.y + toastBox.height;
      expect(overlaps, `toast ${JSON.stringify(toastBox)} over ${testId} ${JSON.stringify(barBox)}`).toBe(false);
    }
    expect(toastBox.y).toBeLessThan(height / 3);
    // The address stays pressable: it is not under the toast.
    await page.getByRole("textbox", { name: "Address" }).click({ trial: true });
    expect(errors).toEqual([]);
  });
}

// A local test, Nov 5, in a 999×1041 window: the waiting toast's first frame
// sat 12 px clear of Chat | Browser, but its left 28 px lay over the sidebar,
// centred as it was on the whole window.
test("a toast sits over the workspace, right of the sidebar (999×1041)", async ({ page }) => {
  await page.setViewportSize({ width: 999, height: 1041 });
  const errors = await mount(page, "desktop-sidebar");
  await page.evaluate(() => (window as unknown as { __showReplyToast: () => void }).__showReplyToast());
  const toast = page.getByTestId("status-toast");
  await expect(toast).toBeVisible();
  const toastBox = (await toast.boundingBox())!;
  const sidebarBox = (await page.getByTestId("sidebar").boundingBox())!;
  const workspaceBox = (await page.getByTestId("studio-workspace").boundingBox())!;
  expect(toastBox.x, `toast ${JSON.stringify(toastBox)}, sidebar ${JSON.stringify(sidebarBox)}`)
    .toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
  // Centred over the workspace, inside it.
  expect(Math.abs(toastBox.x + toastBox.width / 2 - (workspaceBox.x + workspaceBox.width / 2))).toBeLessThanOrEqual(1);
  expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(workspaceBox.x + workspaceBox.width);
  // And still under the Chat | Browser bar.
  const barBox = (await page.getByTestId("conversation-subtabs").boundingBox())!;
  expect(toastBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
  expect(errors).toEqual([]);
});

// Centred over the whole workspace, the toast in that window covered 176 px of
// the participants drawer, which lies over the workspace's right edge.
test("a toast sits left of the participants drawer (999×1041)", async ({ page }) => {
  await page.setViewportSize({ width: 999, height: 1041 });
  const errors = await mount(page, "desktop-sidebar-people");
  await page.evaluate(() => (window as unknown as { __showReplyToast: () => void }).__showReplyToast());
  const toast = page.getByTestId("status-toast");
  await expect(toast).toBeVisible();
  const toastBox = (await toast.boundingBox())!;
  const sidebarBox = (await page.getByTestId("sidebar").boundingBox())!;
  const drawerBox = (await page.getByTestId("participants-drawer").boundingBox())!;
  expect(toastBox.x, `toast ${JSON.stringify(toastBox)}, sidebar ${JSON.stringify(sidebarBox)}`)
    .toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
  expect(toastBox.x + toastBox.width, `toast ${JSON.stringify(toastBox)}, drawer ${JSON.stringify(drawerBox)}`)
    .toBeLessThanOrEqual(drawerBox.x);
  // Centred in the room between them.
  const room = { left: sidebarBox.x + sidebarBox.width, right: drawerBox.x };
  expect(Math.abs(toastBox.x + toastBox.width / 2 - (room.left + room.right) / 2)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

/**
 * Every frame's toast and bars, from now: where the toast is (its painted box,
 * animation included) and where the lowest bar it must clear ends.
 */
async function recordFrames(page: Page, bars: string) {
  await page.evaluate((selector) => {
    const frames: Array<{ toastTop: number; toastBottom: number; barBottom: number }> = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const sample = () => {
      const toast = document.querySelector<HTMLElement>('[data-testid="status-toast"]');
      if (toast) {
        const box = toast.getBoundingClientRect();
        const barBottom = Math.max(0, ...Array.from(document.querySelectorAll<HTMLElement>(selector))
          .map((bar) => bar.getBoundingClientRect())
          .filter((bar) => bar.width > 0 && bar.height > 0 && bar.top < box.bottom)
          .map((bar) => bar.bottom));
        frames.push({ toastTop: Math.round(box.top), toastBottom: Math.round(box.bottom), barBottom: Math.round(barBottom) });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, bars);
}

async function frames(page: Page) {
  return page.evaluate(() => (window as unknown as { __frames: Array<{ toastTop: number; toastBottom: number; barBottom: number }> }).__frames);
}

// A local test, Nov 3: the toast "The agent is saving right now. Try again in
// a moment." first drew over Chat | Browser, then sat below it: it slid in
// from 10 px above the place it keeps, 8 px under the bar.
test("a warning toast keeps Chat | Browser clear from its first frame", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const errors = await mount(page, "desktop");
  await recordFrames(page, '[data-testid="conversation-subtabs"]');
  await page.evaluate(() => (window as unknown as { __showWarningToast: () => void }).__showWarningToast());
  await expect(page.getByTestId("status-toast")).toBeVisible();
  await page.waitForTimeout(400);
  const seen = await frames(page);
  expect(seen.length).toBeGreaterThan(5);
  expect(seen.filter((frame) => frame.toastTop < frame.barBottom), JSON.stringify(seen.slice(0, 5))).toEqual([]);
  // It appears where it stays.
  expect(new Set(seen.map((frame) => frame.toastTop)).size).toBe(1);
  expect(errors).toEqual([]);
});

// A local test, Nov 3: a toast on screen when the person opened a chat's
// Browser view drew over the place its address bar comes, until the browser's
// controls loaded 0.35 s later and the address bar pushed it down.
test("a toast on screen stays clear and in place while the Browser view starts and its address bar comes", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const errors = await mount(page, "desktop-browser-starting");
  await page.evaluate(() => (window as unknown as { __showReplyToast: () => void }).__showReplyToast());
  await expect(page.getByTestId("status-toast")).toBeVisible();
  await page.waitForTimeout(300);
  await recordFrames(page, '[data-testid="conversation-subtabs"], [data-testid="browser-session-toolbar"], [data-testid="shared-browser-chrome"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as { __browserControlsLoaded: () => void }).__browserControlsLoaded());
  await expect(page.getByTestId("shared-browser-chrome")).toBeVisible();
  await page.waitForTimeout(300);
  const seen = await frames(page);
  expect(seen.length).toBeGreaterThan(5);
  expect(seen.filter((frame) => frame.toastTop < frame.barBottom), JSON.stringify(seen.slice(0, 5))).toEqual([]);
  expect(new Set(seen.map((frame) => frame.toastTop)).size, JSON.stringify(seen)).toBe(1);
  expect(errors).toEqual([]);
});
