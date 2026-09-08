import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__composer-action-menu-mobile-fixture__";
test.use({ hasTouch: true });

// Real menu and shared popover layout, with inert callbacks and no controller.
// Viewport resizing models the space available around an on-screen keyboard;
// native keyboard and Android Back integration are verified separately.
async function mountMenu(page: Page): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ComposerActionMenu } from "/src/screens/studio/components/ComposerActionMenu.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const noop = () => {};
    createRoot(document.getElementById("root")).render(h("main", null,
      h("p", { style: { padding: 12 } }, "Synthetic menu layout. Actions are inert."),
      h("div", { style: { position: "fixed", left: 20, right: 20, bottom: 12, display: "flex", gap: 8 } },
        h(ComposerActionMenu, {
          pendingNewBrowser: false, touchLikeInput: true,
          onOpenBrowser: noop, onOpenNewBrowser: noop, onOpenInvite: noop,
          onImportGithubRepo: noop, onInsertCommand: noop,
          onQueueMessage: noop, onStashDraft: noop, onUploadImage: noop,
          onInsertSuggestion: noop, onStartVoiceInput: noop, onToggleVoiceReplies: noop,
          triggerIconClassName: "h-5 w-5",
        }),
        h("textarea", { "aria-label": "Layout fixture draft", style: { minWidth: 0, flex: 1, height: 40 } }),
      ),
    ));`;
  await page.route(`**${FIXTURE_PATH}/main.js`, route => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.route(`**${FIXTURE_PATH}`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <script type="module">
      import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
      window.__vite_plugin_react_preamble_installed__=true;
    </script><script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>` }));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("composer-action-menu-trigger")).toBeVisible();
  expect(errors).toEqual([]);
}

async function expectContainedScroll(page: Page): Promise<number> {
  const menu = page.getByTestId("composer-action-menu");
  const content = menu.locator("[data-studio-popover-content]");
  await expect(menu).toBeVisible();
  await expect(content).toHaveCSS("overflow-y", "auto");
  const bounds = await content.evaluate(node => {
    const content = node.getBoundingClientRect();
    const panel = node.closest("[data-studio-popover]")!.getBoundingClientRect();
    return { top: content.top, bottom: content.bottom, panelTop: panel.top, panelBottom: panel.bottom, height: node.clientHeight, scrollHeight: node.scrollHeight };
  });
  expect(bounds.panelTop).toBeGreaterThanOrEqual(0);
  expect(bounds.panelBottom).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.panelTop);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.panelBottom);
  expect(bounds.scrollHeight).toBeGreaterThan(bounds.height);
  return bounds.height;
}

for (const width of [320, 393]) {
  test(`keeps all menu actions within a scrollable panel on a ${width}px phone as available height changes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 400 });
    await mountMenu(page);
    await page.getByRole("textbox").focus();
    await page.getByTestId("composer-action-menu-trigger").tap();
    const shortHeight = await expectContainedScroll(page);
    await expect(page.getByTestId("composer-action-menu-enter-hint")).toHaveText("Enter adds a line · Use the send button to send or steer");

    const content = page.getByTestId("composer-action-menu").locator("[data-studio-popover-content]");
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const commands = page.getByTestId("composer-action-menu-commands");
    await expect(commands).toBeInViewport({ ratio: 1 });
    expect(await commands.evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("short-menu.png") });

    // Closing the keyboard enlarges the viewport without reopening the menu.
    await page.setViewportSize({ width, height: 720 });
    await expect.poll(async () => (await content.boundingBox())!.height).toBeGreaterThan(shortHeight);
    await commands.tap();
    const command = page.locator('[data-testid^="composer-action-menu-command-"]').last();
    await command.scrollIntoViewIfNeeded();
    await expect(command).toBeInViewport({ ratio: 1 });
    await command.tap();
    await expect(page.getByTestId("composer-action-menu")).toBeHidden();
    await expect(page.getByTestId("composer-action-menu-trigger")).toBeFocused();
  });
}
