import { test, expect, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs.js";

// A page's row under a reply waits for its words while the chat's history
// comes in ("Created Three days in Seville"), with a quiet pulse in their
// place. In a local test that row grew by 36 to 95 px when its words came,
// moving "Review changes · Undo" beside it. The real ChatFileChangeList is
// mounted against the running Vite server, its data and context hooks
// stubbed, and drawn waiting, then with its words: the row keeps its width.

const FIXTURE_PATH = "/__chat-file-change-pending-width__";

async function mountFixture(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 600 });
  const deps = await resolveViteReactDependencies(page);

  const sdkStub = `
    export const controllerClient = {
      workspace: {
        git: {
          fetchDiff: async () => ({ supported: true, path: "", commit: null, diff: "", truncated: false, error: null }),
          revertPaths: async () => ({ ok: true, removed: [] }),
        },
        files: { read: async () => ({ isText: true, contentText: "" }) },
      },
    };`;
  const runtimeStub = `export function useRuntime() { return { effectiveRuntimeId: "rt-demo", runtimeReady: false }; }`;
  const statusStub = `export function useStatus() { return { showStatus: () => {} }; }`;
  const tabsStub = `export function useWorkspaceTabs() { return { openPanelTab() {}, requestUrlPush() {}, openGitDiffTab() {} }; }`;

  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatFileChangeList } from "/src/screens/studio/components/ChatFileChangeList.tsx";
    import {
      ChatSiteContext, ChatSiteSettledContext, ChatSiteSoFarContext,
    } from "/src/screens/studio/components/chatSiteContext.ts";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    // The chat's first change made the page; its card, already in, names it.
    const site = { firstChangeAt: 1000, pageTitles: new Map([["seville-3-days", window.__title]]) };
    const files = ["sites/seville-3-days/index.html", "sites/seville-3-days/map.config.json"].map((path) => ({
      path, workspacePath: path, label: path, changeType: "created", lineRanges: [],
    }));
    const root = createRoot(document.getElementById("root"));
    // Waiting: the chat's history is still coming in, so whether an older
    // change made the page is not known yet.
    window.__draw = (waiting) => root.render(
      h(ChatSiteContext.Provider, { value: waiting ? undefined : site },
        h(ChatSiteSoFarContext.Provider, { value: site },
          h(ChatSiteSettledContext.Provider, { value: !waiting },
            h("div", { style: { maxWidth: "640px", padding: "8px" } },
              h(ChatFileChangeList, { files, projectId: "p1", messageId: "m1", messageTimestamp: 1000 }))))));
    window.__draw(true);
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
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

  const js = (body: string) => ({ contentType: "application/javascript", body });
  // Inert data boundaries first; the row's own stubs below take their place where both name a module.
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, (route) => route.fulfill(js(body)));
  }
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill(js(sdkStub)));
  await page.route("**/src/runtime/useRuntime.tsx*", (route) => route.fulfill(js(runtimeStub)));
  await page.route("**/src/status/useStatus.tsx*", (route) => route.fulfill(js(statusStub)));
  await page.route("**/src/workspace/WorkspaceTabsProvider.tsx*", (route) => route.fulfill(js(tabsStub)));

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, { timeout: 20_000 });
  await page.waitForSelector('[data-testid="chat-file-change-toggle-files"][aria-busy="true"]');
  expect(errors, `no page errors: ${errors.join("; ")}`).toEqual([]);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width } : null;
    };
    const row = document.querySelector('[data-testid="chat-file-change-toggle-files"]');
    return {
      row: box('[data-testid="chat-file-change-toggle-files"]'),
      review: box('[data-testid="chat-file-change-review"]'),
      waiting: row?.getAttribute("aria-busy") === "true",
      // What the row shows and says: while it waits, only "Loading…" for a screen reader.
      text: (row as HTMLElement | null)?.innerText.trim() ?? "",
    };
  });
}

for (const [width, title] of [
  [1280, "Three days in Seville"],
  [375, "Three days in Seville"],
  [1280, "A very long page title that the row cuts short with an ellipsis at its end"],
] as const) {
  test(`a page's row keeps its width when its words come (${width} px, ${title.length} characters)`, async ({ page }) => {
    await page.addInitScript((pageTitle) => { (window as { __title?: string }).__title = pageTitle; }, title);
    await mountFixture(page, width);
    const waiting = await measure(page);
    expect(waiting.waiting).toBe(true);
    expect(waiting.text).toBe("Loading…");

    await page.evaluate(() => (window as { __draw?: (waiting: boolean) => void }).__draw?.(false));
    await expect(page.locator('[data-testid="chat-file-change-toggle-files"]')).not.toHaveAttribute("aria-busy", "true");
    const shown = await measure(page);
    expect(shown.text).toContain("Created ");

    expect(waiting.row).not.toBeNull();
    expect(shown.row).not.toBeNull();
    expect(Math.abs(shown.row!.width - waiting.row!.width)).toBeLessThan(0.5);
    // Nothing beside it moved.
    expect(waiting.review).not.toBeNull();
    expect(Math.abs(shown.review!.x - waiting.review!.x)).toBeLessThan(0.5);
    expect(Math.abs(shown.review!.y - waiting.review!.y)).toBeLessThan(0.5);
  });
}
