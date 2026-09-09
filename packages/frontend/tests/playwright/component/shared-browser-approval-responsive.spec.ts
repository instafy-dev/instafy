import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__shared-browser-approval-responsive_fixture__";
const LIFECYCLE_FIXTURE_PATH = "/__shared-browser-approval-lifecycle_fixture__";

async function mountApprovalPrompt(page: Page, routineApprovalAvailable = false): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { SharedBrowserApprovalPrompt } from "/src/screens/studio/components/SharedBrowserApprovalPrompt.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const request = {
      approvalId: "11111111-1111-4111-8111-111111111111",
      kind: "origin",
      operation: "approve-origin",
      sourceOrigin: "https://source.example.test",
      destinationOrigin: "https://a-long-destination-name.example.test",
      expiresAtMs: Date.now() + 30000,
      display: {
        label: "Use the destination site",
        destinationOrigin: "https://a-long-destination-name.example.test",
      },
    };
    createRoot(document.getElementById("root")).render(
      h("main", { className: "relative h-dvh w-screen overflow-hidden bg-slate-950" },
        h(SharedBrowserApprovalPrompt, {
          routineApprovalAvailable: ${routineApprovalAvailable},
          request,
          submitting: false,
          error: null,
          onDecision: (decision) => { window.__decision = decision; },
        }),
      ),
    );
    window.__mounted = true;`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <style>html, body, #root { margin: 0; min-width: 0; width: 100%; height: 100%; }</style>
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

  await page.route(`**${FIXTURE_PATH}`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: main }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true);
  expect(errors, errors.join("; ")).toEqual([]);
}

for (const viewport of [
  { name: "phone", width: 360, height: 800 },
  { name: "short-landscape", width: 667, height: 375 },
]) {
  test(`offers early routine approval on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mountApprovalPrompt(page, true);
    const routine = page.getByTestId("shared-browser-approval-routine");
    await expect(routine).not.toBeChecked();
    await expect(page.getByTestId("shared-browser-approval-deny")).toBeFocused();
    const prompt = page.getByTestId("shared-browser-approval-prompt");
    const bounds = await prompt.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.getByTestId("shared-browser-approval-content").evaluate((element) => { element.scrollTop = 0; });
    await expect(page.getByRole("heading", { name: "Allow the AI agent to use this site?" })).toBeInViewport();
    await expect(page.getByTestId("shared-browser-approval-allow")).toBeInViewport();
    await routine.check();
    await expect(page.getByTestId("shared-browser-approval-deny")).toBeInViewport();
    await routine.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("shared-browser-approval-allow")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(routine).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("shared-browser-approval-deny")).toBeFocused();
    const screenshotPath = testInfo.outputPath(`routine-browsing-${viewport.name}.png`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`Routine browsing ${viewport.name}`, { contentType: "image/png", path: screenshotPath });
    await page.getByTestId("shared-browser-approval-allow").click();
    await expect.poll(() => page.evaluate(() => (window as { __decision?: string }).__decision)).toBe("allow_routine");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
  test(`keeps Shared Browser approval usable on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mountApprovalPrompt(page);

    const prompt = page.getByTestId("shared-browser-approval-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveAccessibleName("Allow the AI agent to use this site?");
    await expect(page.getByTestId("shared-browser-approval-destination")).toContainText(
      "a-long-destination-name.example.test",
    );
    await expect(page.getByTestId("shared-browser-approval-deny")).toBeFocused();

    const bounds = await prompt.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width);
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );

    await page.getByTestId("shared-browser-approval-allow").click();
    await expect
      .poll(() => page.evaluate(() => (window as { __decision?: string }).__decision))
      .toBe("allow_origin");

    const screenshotPath = testInfo.outputPath(`shared-browser-approval-${viewport.name}.png`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`Shared Browser approval ${viewport.name}`, {
      contentType: "image/png",
      path: screenshotPath,
    });
  });
}

async function mountApprovalTransportLifecycle(
  page: Page,
  initialTab: "chat" | "browser",
): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatBrowserSubtabs } from "/src/screens/studio/components/ChatBrowserSubtabs.tsx";
    import { SharedBrowserApprovalPrompt } from "/src/screens/studio/components/SharedBrowserApprovalPrompt.tsx";
    import { useSharedBrowserApprovalTransport } from "/src/screens/studio/components/useSharedBrowserApprovalTransport.ts";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const request = {
      approvalId: "11111111-1111-4111-8111-111111111111",
      kind: "origin",
      operation: "approve-origin",
      sourceOrigin: "https://example.test",
      destinationOrigin: "https://example.test",
      expiresAtMs: Date.now() + 30000,
      display: { label: "Use example.test", destinationOrigin: "https://example.test" },
    };
    function Fixture() {
      const [tab, setTab] = React.useState(${JSON.stringify(initialTab)});
      const [transport, setTransport] = React.useState("personal");
      const revealSharedBrowser = React.useCallback(() => setTransport("shared"), []);
      useSharedBrowserApprovalTransport({
        pending: true,
        transport,
        revealSharedBrowser,
      });
      return h("main", { className: "relative flex h-dvh w-screen flex-col overflow-hidden" },
        h(ChatBrowserSubtabs, {
          activeTab: tab,
          browserAttention: true,
          browserPanelId: "browser-panel",
          chatPanelId: "chat-panel",
          onTabChange: setTab,
        }),
        h("section", {
          id: "chat-panel",
          hidden: tab !== "chat",
          role: "tabpanel",
          "data-testid": "approval-lifecycle-chat",
        }, "Chat remains selected until the user opens Browser."),
        h("section", {
          id: "browser-panel",
          hidden: tab !== "browser",
          role: "tabpanel",
          className: "relative min-h-0 flex-1 bg-slate-950",
        },
          h("span", { "data-testid": "approval-lifecycle-transport" }, transport),
          h("div", { hidden: transport !== "personal", "data-testid": "approval-lifecycle-personal" }, "Personal"),
          h("div", { hidden: transport !== "shared", className: "absolute inset-0" },
            h(SharedBrowserApprovalPrompt, {
              active: tab === "browser" && transport === "shared",
              request,
              submitting: false,
              error: null,
              onDecision: () => {},
            }),
          ),
        ),
      );
    }
    createRoot(document.getElementById("root")).render(h(Fixture));
    window.__mounted = true;`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <style>html, body, #root { margin: 0; min-width: 0; width: 100%; height: 100%; }</style>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${LIFECYCLE_FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>`;

  await page.route(`**${LIFECYCLE_FIXTURE_PATH}`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route(`**${LIFECYCLE_FIXTURE_PATH}/main.js`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: main }),
  );
  await page.goto(LIFECYCLE_FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true);
}

test("keeps a Chat-hidden approval discoverable and focuses Deny when opened", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountApprovalTransportLifecycle(page, "chat");

  await expect(page.getByTestId("approval-lifecycle-chat")).toBeVisible();
  await expect(page.getByTestId("shared-browser-approval-attention")).toBeVisible();
  await expect(page.getByTestId("approval-lifecycle-transport")).toHaveText("shared");
  await expect(page.getByTestId("shared-browser-approval-prompt")).toBeHidden();

  await page.getByTestId("conversation-subtab-browser").click();
  await expect(page.getByTestId("shared-browser-approval-prompt")).toBeVisible();
  await expect(page.getByTestId("shared-browser-approval-deny")).toBeFocused();
});

test("reveals a pending Shared approval that arrived over Personal Browser", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountApprovalTransportLifecycle(page, "browser");

  await expect(page.getByTestId("approval-lifecycle-transport")).toHaveText("shared");
  await expect(page.getByTestId("approval-lifecycle-personal")).toBeHidden();
  await expect(page.getByTestId("shared-browser-approval-prompt")).toBeVisible();
  await expect(page.getByTestId("shared-browser-approval-deny")).toBeFocused();
});
