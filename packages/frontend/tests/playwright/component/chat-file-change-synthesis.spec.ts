import { test, expect, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

// Deterministic real-browser coverage for the created-file diff synthesis
// (fix 49585f24) and its interaction with commit-range pinning. The real
// ChatFileChangeList is mounted against the running Vite dev server with the
// controller data layer and context hooks stubbed via module interception —
// no backend, agent, or auth required, so the empty-diff race window can be
// reproduced deterministically (impossible against a live origin).

const FIXTURE_PATH = "/__chat-file-change-fixture__";

type Scenario = {
  changeType: "created" | "changed";
  diff: string;
  fileContents: string;
  commitRange?: { base: string; head: string };
};

async function mountFixture(page: Page, scenario: Scenario): Promise<void> {
  const deps = await resolveViteReactDependencies(page);

  const sdkStub = `
    export const controllerClient = {
      workspace: {
        git: {
          fetchDiff: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { supported: true, path: "", commit: null, diff: ${JSON.stringify(scenario.diff)}, truncated: false, error: null };
          },
          revertPaths: async () => ({ ok: true, removed: [] }),
        },
        files: {
          read: async () => {
            window.__readCount = (window.__readCount ?? 0) + 1;
            return { isText: true, contentText: ${JSON.stringify(scenario.fileContents)} };
          },
        },
      },
    };`;

  const runtimeStub = `export function useRuntime() { return { effectiveRuntimeId: "rt-demo", runtimeReady: true }; }`;
  const statusStub = `export function useStatus() { return { showStatus: () => {} }; }`;
  const tabsStub = `export function useWorkspaceTabs() { return { openPanelTab() {}, requestUrlPush() {}, openGitDiffTab() {} }; }`;

  const commitRangeLiteral = scenario.commitRange
    ? `{ base: ${JSON.stringify(scenario.commitRange.base)}, head: ${JSON.stringify(scenario.commitRange.head)} }`
    : "null";

  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatFileChangeList } from "/src/screens/studio/components/ChatFileChangeList.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const files = [{
      path: "hello.txt", workspacePath: "hello.txt", label: "hello.txt",
      changeType: ${JSON.stringify(scenario.changeType)}, lineRanges: [],
    }];
    createRoot(document.getElementById("root")).render(
      React.createElement(ChatFileChangeList, { files, projectId: "p1", commitRange: ${commitRangeLiteral} }),
    );
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
  await page.route("**/__chat-file-change-fixture__", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route("**/__chat-file-change-fixture__/main.js", (route) => route.fulfill(js(main)));
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill(js(sdkStub)));
  await page.route("**/src/runtime/useRuntime.tsx*", (route) => route.fulfill(js(runtimeStub)));
  await page.route("**/src/status/useStatus.tsx*", (route) => route.fulfill(js(statusStub)));
  await page.route("**/src/workspace/WorkspaceTabsProvider.tsx*", (route) =>
    route.fulfill(js(tabsStub)),
  );

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
    timeout: 20_000,
  });
  await page.waitForSelector('[data-testid="chat-file-change-file-chip"]');
  // Flush the async diff-loading effect (fetch -> maybe read -> render).
  await page.waitForTimeout(300);
  expect(errors, `no page errors: ${errors.join("; ")}`).toEqual([]);
}

async function openCard(page: Page): Promise<string> {
  await page.locator('[data-testid="chat-file-change-file-chip"]').first().click();
  const row = page.locator('[data-testid="chat-file-change-row"]').first();
  await expect(row).toBeVisible();
  return (await row.textContent()) ?? "";
}

test.describe("chat file change synthetic diff", () => {
  test("created file with an empty origin diff synthesizes the added-lines diff", async ({ page }) => {
    await mountFixture(page, {
      changeType: "created",
      diff: "",
      fileContents: "hello from the agent\nsecond line\n",
    });
    const cardText = await openCard(page);
    expect(cardText).toContain("hello from the agent");
    expect(cardText).not.toContain("No diff available");
    expect(await page.evaluate(() => (window as { __readCount?: number }).__readCount ?? 0)).toBe(1);
  });

  test("created file with a real origin diff renders it without synthesizing", async ({ page }) => {
    await mountFixture(page, {
      changeType: "created",
      commitRange: { base: "a".repeat(40), head: "b".repeat(40) },
      diff: "diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1,2 @@\n+from the origin\n+not synthesized",
      fileContents: "SHOULD NOT BE READ\n",
    });
    const cardText = await openCard(page);
    expect(cardText).toContain("from the origin");
    expect(cardText).not.toContain("SHOULD NOT BE READ");
    expect(cardText).not.toContain("No diff available");
    expect(await page.evaluate(() => (window as { __readCount?: number }).__readCount ?? 0)).toBe(0);
  });

  test("changed file with an empty origin diff does not synthesize", async ({ page }) => {
    await mountFixture(page, {
      changeType: "changed",
      diff: "",
      fileContents: "unchanged body\n",
    });
    const cardText = await openCard(page);
    expect(cardText).toContain("No diff available");
    expect(cardText).not.toContain("unchanged body");
    expect(await page.evaluate(() => (window as { __readCount?: number }).__readCount ?? 0)).toBe(0);
  });
});
