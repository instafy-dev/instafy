import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__toast-view-bar-clearance__";

type Layout = "desktop" | "phone" | "phone-file" | "desktop-browser" | "phone-browser";

/**
 * Studio's header and its Chat | Browser bar as the real components draw
 * them, with the real toast region. Desktop: the open chats' tab strip, then
 * the view bar. Phone: the page header, with the view bar beside the composer
 * in a chat, or under the header on a chat's file. In the Browser view, the
 * browser's own bar with its address comes under them.
 */
async function mount(page: Page, layout: Layout) {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from ${JSON.stringify(deps.react)};
    import ReactDomClientNS from ${JSON.stringify(deps.reactDomClient)};
    import { StatusProvider } from "/src/status/StatusProvider.tsx";
    import { Status } from "/src/status/Status.tsx";
    import { useStatus } from "/src/status/useStatus.tsx";
    import { ConversationSurfaceTabs } from "/src/workspace/ConversationSurfaceLayout.tsx";
    import { ConversationQuickTabs } from "/src/workspace/ConversationQuickTabs.tsx";
    import { BrowserChromeShell } from "/src/screens/studio/components/BrowserChromeShell.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const layout = ${JSON.stringify(layout)};
    const browser = layout.endsWith("-browser");
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
    function Fixture() {
      const { showStatus } = useStatus();
      window.__showReplyToast = () => showStatus("There is a new reply in “Plan 3 days in Seville for a first…”.", "info", 0,
        { actionLabel: "View", onAction: () => {}, nonPreemptive: true });
      const header = layout.startsWith("desktop")
        ? h("div", { className: "flex h-12 items-end px-4" }, h(ConversationQuickTabs, {
            tabs: chats, activeId: "porto", scopeName: "Porto weekend", onSelect: () => {}, onClose: () => {}, onKeep: () => {} }))
        : h("header", { className: "flex h-14 shrink-0 items-center px-4 text-sm font-semibold" }, "Open visitporto.travel in your…");
      const besideComposer = layout === "phone" || layout === "phone-browser";
      // The Browser view's own bar, as the shared browser draws it: its
      // address, on the page the turn left open.
      const browserBar = browser ? h(BrowserChromeShell, {
        label: "Shared browser controls", testId: "browser-view-bar", navigation: null,
        address: h("input", { "aria-label": "Address", readOnly: true, value: "https://httpbin.org/forms/post",
          className: "h-8 w-full min-w-0 rounded-full border border-slate-200 px-3 text-sm" }),
      }) : null;
      return h("div", { className: "flex h-dvh flex-col bg-white text-slate-800" },
        header,
        besideComposer ? null : views("header"),
        browserBar,
        h("main", { id: "chat-panel", className: "min-h-0 flex-1 overflow-hidden p-4 text-sm" }, "Octo wants to click “Edit” on en.metrodoporto.pt."),
        h("div", { className: "m-3 rounded-2xl border border-slate-200 p-2" },
          besideComposer ? views("composer") : null,
          h("div", { className: "px-2 py-2 text-sm text-slate-400" }, "Ask for something…")),
        h(Status));
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
