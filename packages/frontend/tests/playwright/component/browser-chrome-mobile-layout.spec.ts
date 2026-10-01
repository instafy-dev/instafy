import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__browser-chrome-mobile-layout-fixture__";

async function mountCompactBrowserChrome(page: Page): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { BrowserStatusPill } from "/src/screens/studio/components/BrowserChromeShell.tsx";
    import { BrowserExpandButton } from "/src/screens/studio/components/BrowserExpandButton.tsx";
    import { ConversationSurfaceTabs } from "/src/workspace/ConversationSurfaceLayout.tsx";
    import { BrowserTransportSelector } from "/src/screens/studio/components/PersonalBrowserSurface.tsx";
    import { RemoteBrowserMobileKeyboard } from "/src/screens/studio/components/RemoteBrowserMobileKeyboard.tsx";
    import { SharedBrowserSessionControl } from "/src/screens/studio/components/SharedBrowserSessionControl.tsx";
    import { SharedBrowserChrome } from "/src/screens/studio/components/SharedBrowserChrome.tsx";
    import { SharedBrowserCollaborationControls } from "/src/screens/studio/components/SharedBrowserCollaborationControls.tsx";
    import { shouldUseCompactBrowserChrome } from "/src/screens/studio/components/browserSessionLayout.ts";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const participants = [
      { id: "self", displayName: "A very long local participant name", color: "#0ea5e9", pageId: "page-1", cursor: null, canControl: true },
      { id: "peer", displayName: "A teammate with an exceptionally long display name", color: "#8b5cf6", pageId: "page-1", cursor: null, canControl: true },
      { id: "third", displayName: "Another teammate", color: "#10b981", pageId: "page-1", cursor: null, canControl: true },
      { id: "fourth", displayName: "Fourth teammate", color: "#f97316", pageId: "page-1", cursor: null, canControl: true },
    ];
    const client = {
      connectionStatus: "connected",
      participantId: "self",
      state: {
        revision: 1,
        participants,
        controlOwner: { kind: "human", participantId: "peer" },
        requests: [],
      },
      error: null,
    };
    const pages = [
      { id: "page-1", url: "https://example.com/with/a/long/path", host: "example.com", label: "Example", title: "An exceptionally long active browser tab title", lastReferencedAt: 3, isActive: true },
      { id: "page-2", url: "https://two.example/", host: "two.example", label: "Second", title: "A second long browser tab title", lastReferencedAt: 2, isActive: false },
      { id: "page-3", url: "https://three.example/", host: "three.example", label: "Third", title: "A third long browser tab title", lastReferencedAt: 1, isActive: false },
    ];

    function Fixture() {
      const [agentControls, setAgentControls] = React.useState(false);
      const [optionsOpen, setOptionsOpen] = React.useState(false);
      const [expanded, setExpanded] = React.useState(false);
      const [keyboardHeight, setKeyboardHeight] = React.useState(0);
      const compact = shouldUseCompactBrowserChrome({
        containerWidth: window.innerWidth,
        compactViewport: window.innerWidth < 640,
      });
      React.useEffect(() => {
        window.__setAgentControls = setAgentControls;
        window.__remoteKeyboardMessages = [];
        return () => { delete window.__setAgentControls; };
      }, []);
      const localControlOwner = agentControls
        ? { kind: "agent", displayName: "Octo with a very long agent name" }
        : { kind: "human" };
      const transport = h(BrowserTransportSelector, {
        checked: true,
        compact,
        mode: "shared",
        onModeChange: () => {},
        personalAvailable: true,
      });
      const collaboration = h(SharedBrowserCollaborationControls, {
        client,
        compact,
        localControlOwner,
        onGrantControl: () => {},
        onReleaseControl: () => {},
        onRequestControl: () => {},
        onTakeControl: () => {},
      });
      return h("main", { style: { width: "100vw", overflow: "hidden" } },
        h(ConversationSurfaceTabs, {
          activeId: "browser",
          resourceId: "browser", split: false, wide: false, ratio: .55, onSplitChange: () => {},
          resources: [{ id: "browser", label: "Browser", panelId: "browser-panel", attention: h("span", {"data-testid":"shared-browser-approval-attention"}, "Approve") }],
          chatPanelId: "chat-panel",
          onSelect: () => {},
        }),
        h(SharedBrowserChrome, {
          compact,
          pages,
          resolved: true,
          pendingAction: null,
          error: null,
          onNavigate: () => {},
          onBack: () => {},
          onForward: () => {},
          onReload: () => {},
          onFocusPage: () => {},
          onClearError: () => {},
          toolbarLeading: transport,
          toolbarStatus: h(BrowserStatusPill, {
            compact,
            detail: "Shared Browser is connected and ready.",
            state: "ready",
            testId: "browser-session-status",
          }),
          toolbarActions: (compactNavigation) => h(React.Fragment, null, collaboration, h(SharedBrowserSessionControl, {
            runtimeId: "fixture-runtime", resumeUrl: null, open: optionsOpen, onOpenChange: setOptionsOpen,
            busy: false, candidates: [], error: null, canStart: false, onChoose: () => {}, onStart: () => {}, onRefresh: () => {},
            actions: compact ? h(React.Fragment, null, compactNavigation,
              h(BrowserExpandButton, { expanded, showLabel: true, onPress: () => setExpanded(!expanded) })) : null,
          }), compact ? null : h(BrowserExpandButton, { expanded, onPress: () => setExpanded(!expanded) })),
          interactionEnabled: false,
        }),
        h("div", { "data-testid": "keyboard-layout-stage", style: { position: "relative", height: 240 } },
          h("div", { "data-testid": "keyboard-layout-viewer", style: { position: "absolute", inset: 0, bottom: keyboardHeight } }),
          h(RemoteBrowserMobileKeyboard, {
            enabled: true,
            onOccupiedHeightChange: setKeyboardHeight,
            onMessage: (message) => window.__remoteKeyboardMessages.push(message),
          }),
        ),
      );
    }
    createRoot(document.getElementById("root")).render(h(Fixture));
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <style>html, body, #root { margin: 0; min-width: 0; width: 100%; }</style>
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
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.request().method()} ${response.url()}: HTTP ${response.status()}`);
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "request failed"}`,
    );
  });
  await page.goto(FIXTURE_PATH);
  await page
    .waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
      timeout: 20_000,
    })
    .catch((error: unknown) => {
      const detail = [...errors, ...failedRequests].join("; ") || "no browser error reported";
      throw new Error(`Compact browser fixture did not mount: ${detail}`, { cause: error });
    });
  expect(errors, errors.join("; ")).toEqual([]);
  expect(failedRequests, failedRequests.join("; ")).toEqual([]);
}

async function browserChromeGeometry(page: Page) {
  return page.evaluate(() => {
    const bounds = (testId: string) => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
    };
    const chromeElement = document.querySelector<HTMLElement>('[data-testid="shared-browser-chrome"]');
    return {
      coarse: window.matchMedia("(pointer: coarse)").matches,
      address: bounds("shared-browser-address"),
      collaboration: bounds("shared-browser-collaboration-toggle"),
      browserTab: bounds("conversation-subtab-browser"),
      chrome: bounds("shared-browser-chrome"),
      chromeFits: chromeElement ? chromeElement.scrollWidth <= chromeElement.clientWidth : false,
      documentWidth: document.documentElement.scrollWidth,
      reload: bounds("shared-browser-reload"),
      locationMenu: bounds("browser-location-menu"),
      options: bounds("shared-browser-sessions-toggle"),
    };
  });
}

for (const width of [320, 360, 390]) {
  test(`keeps the compact browser in one address row at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await mountCompactBrowserChrome(page);

    const chrome = page.getByTestId("shared-browser-chrome");
    const participants = page.getByTestId("shared-browser-participants");
    const collaboration = page.getByTestId("shared-browser-collaboration-toggle");
    const controlState = page.getByTestId("shared-browser-collaboration-control-state");
    const action = page.getByTestId("shared-browser-collaboration-control-action");
    const address = page.getByTestId("shared-browser-address");
    const options = page.getByTestId("shared-browser-sessions-toggle");
    const pageSelect = page.getByTestId("shared-browser-page-select");

    await expect(chrome).toBeVisible();
    await expect(participants).toBeVisible();
    await expect(participants).toHaveAttribute("aria-label", /A teammate with an exceptionally long display name/);
    await expect(participants).toContainText("+3");
    await expect(collaboration).toHaveAccessibleName(/A teammate with an exceptionally long display name controls/);
    await expect(controlState).toHaveCount(0);
    await expect(action).toHaveCount(0);
    await expect(pageSelect).toHaveCount(0);
    await expect(page.getByTestId("browser-session-fullscreen-toggle")).toHaveCount(0);
    await expect(address).toBeVisible();
    await expect(page.getByTestId("conversation-subtab-browser")).toHaveAccessibleName("Browser, approval needed");
    await expect(page.getByTestId("shared-browser-approval-attention")).toBeVisible();

    const geometry = await browserChromeGeometry(page);

    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    expect(geometry.chromeFits).toBe(true);
    expect(geometry.coarse).toBe(false);
    expect(geometry.chrome?.height).toBe(48);
    expect(geometry.address?.width ?? 0).toBeGreaterThanOrEqual(96);
    expect(geometry.collaboration!.left - geometry.address!.right).toBeCloseTo(4, 1);
    expect(geometry.options!.left - geometry.collaboration!.right).toBeCloseTo(4, 1);
    for (const target of [geometry.address, geometry.collaboration, geometry.reload, geometry.locationMenu, geometry.options]) {
      expect(Math.abs(target!.top - geometry.chrome!.top - 4)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.chrome!.bottom - target!.bottom - 4)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(geometry.collaboration!.top - geometry.address!.top)).toBeLessThanOrEqual(2);
    for (const target of [geometry.collaboration, geometry.browserTab, geometry.reload, geometry.locationMenu, geometry.options]) {
      expect(target).not.toBeNull();
      expect(target!.height).toBeGreaterThanOrEqual(40);
      expect(target!.left).toBeGreaterThanOrEqual(0);
      expect(target!.right).toBeLessThanOrEqual(width);
    }

    await collaboration.click();
    const participantsDialog = page.getByRole("dialog", { name: "Browser participants and control" });
    await expect(participantsDialog).toBeVisible();
    await expect(controlState).toContainText("A teammate with an exceptionally long display name controls");
    await expect(controlState).toHaveClass(/sr-only/);
    const participantList = participantsDialog.getByRole("list", { name: "Browser participants" });
    await expect(participantList.getByRole("listitem")).toHaveCount(4);
    const controllerIndicator = participantsDialog.getByTestId("shared-browser-controller-indicator");
    await expect(controllerIndicator).toHaveCount(1);
    await expect(controllerIndicator).toHaveAccessibleName("A teammate with an exceptionally long display name controls");
    await expect(participantList.locator('li[data-participant-id="peer"]').getByTestId("shared-browser-controller-indicator")).toBeVisible();
    await expect(participantList.locator('li[data-participant-id="self"]').getByTestId("shared-browser-controller-indicator")).toHaveCount(0);
    await expect(action).toHaveAccessibleName("Request control");
    await expect(action).toHaveText("Request control");
    await expect(action).toBeEnabled();
    const listBounds = await participantList.boundingBox();
    const actionBounds = await action.boundingBox();
    expect(listBounds).not.toBeNull();
    expect(actionBounds).not.toBeNull();
    expect(actionBounds!.y).toBeGreaterThanOrEqual(listBounds!.y + listBounds!.height);
    expect(actionBounds!.x + actionBounds!.width).toBeCloseTo(listBounds!.x + listBounds!.width, 0);
    await expect(participantsDialog).not.toContainText("Ask ");
    await page.keyboard.press("Escape");
    await expect(participantsDialog).toHaveCount(0);
    await expect(collaboration).toBeFocused();

    await options.click();
    const optionsDialog = page.getByRole("dialog", { name: "Browser options" });
    await expect(optionsDialog).toBeVisible();
    await expect(page.getByTestId("shared-browser-back")).toBeVisible();
    await expect(page.getByTestId("shared-browser-forward")).toBeVisible();
    await expect(page.getByTestId("shared-browser-back")).toBeDisabled();
    await expect(page.getByTestId("shared-browser-forward")).toBeDisabled();
    await expect(pageSelect).toBeVisible();
    await expect(pageSelect.locator("option")).toHaveCount(3);
    await expect(pageSelect).toBeDisabled();
    const expand = page.getByTestId("browser-session-fullscreen-toggle");
    await expect(expand).toBeVisible();
    await expect(expand).toHaveAccessibleName("Expand browser");
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(expand).toHaveAccessibleName("Exit expanded browser");
    const optionsBounds = await optionsDialog.boundingBox();
    expect(optionsBounds).not.toBeNull();
    expect(optionsBounds!.x).toBeGreaterThanOrEqual(0);
    expect(optionsBounds!.x + optionsBounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(optionsDialog).toHaveCount(0);
    await expect(options).toBeFocused();

    await page.evaluate(() => {
      const setAgentControls = (window as Window & { __setAgentControls?: (active: boolean) => void }).__setAgentControls;
      if (!setAgentControls) throw new Error("Compact browser fixture was not ready");
      setAgentControls(true);
    });
    await expect(collaboration).toHaveAccessibleName(/Octo with a very long agent name controls/);
    await collaboration.click();
    await expect(controlState).toContainText("Octo with a very long agent name controls");
    await expect(controlState).toHaveClass(/sr-only/);
    await expect(controllerIndicator).toHaveCount(1);
    await expect(controllerIndicator).toHaveAccessibleName("Octo with a very long agent name controls");
    await expect(participantList.locator('li[data-controller-kind="agent"]').getByTestId("shared-browser-controller-indicator")).toBeVisible();
    await expect(participantList.locator('li[data-participant-id]').getByTestId("shared-browser-controller-indicator")).toHaveCount(0);
    await expect(action).toHaveCount(0);
    await page.keyboard.press("Escape");

    const screenshotPath = testInfo.outputPath(`shared-browser-chrome-${width}x800.png`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`Shared Browser compact chrome at ${width}×800`, {
      contentType: "image/png",
      path: screenshotPath,
    });
  });
}

test("keeps comfortable touch targets and spacing in the 320px browser toolbar", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 320, height: 800 } });
  try {
    const page = await context.newPage();
    await mountCompactBrowserChrome(page);
    await expect(page.getByTestId("shared-browser-chrome")).toBeVisible();
    const geometry = await browserChromeGeometry(page);

    expect(geometry.coarse).toBe(true);
    expect(geometry.chrome?.height).toBe(52);
    expect(geometry.chromeFits).toBe(true);
    expect(geometry.documentWidth).toBeLessThanOrEqual(320);
    expect(geometry.address?.width ?? 0).toBeGreaterThanOrEqual(96);
    expect(geometry.collaboration!.left - geometry.address!.right).toBeCloseTo(4, 1);
    expect(geometry.options!.left - geometry.collaboration!.right).toBeCloseTo(4, 1);
    for (const target of [geometry.address, geometry.collaboration, geometry.reload, geometry.locationMenu, geometry.options]) {
      expect(target).not.toBeNull();
      expect(target!.height).toBeGreaterThanOrEqual(44);
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.left).toBeGreaterThanOrEqual(0);
      expect(target!.right).toBeLessThanOrEqual(320);
      expect(Math.abs(target!.top - geometry.chrome!.top - 4)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.chrome!.bottom - target!.bottom - 4)).toBeLessThanOrEqual(1);
    }
  } finally {
    await context.close();
  }
});

test("keeps the unified browser address usable at tablet portrait width", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await mountCompactBrowserChrome(page);

  const chrome = page.getByTestId("shared-browser-chrome");
  const address = page.getByTestId("shared-browser-address");
  const transport = page.getByTestId("browser-transport-selector");

  await expect(transport).toHaveAttribute("data-compact", "true");
  await expect(chrome).toBeVisible();
  await expect(address).toBeVisible();

  const geometry = await page.evaluate(() => {
    const chromeElement = document.querySelector<HTMLElement>(
      '[data-testid="shared-browser-chrome"]',
    );
    const addressElement = document.querySelector<HTMLElement>(
      '[data-testid="shared-browser-address"]',
    );
    return {
      addressWidth: addressElement?.getBoundingClientRect().width ?? 0,
      chromeFits: chromeElement ? chromeElement.scrollWidth <= chromeElement.clientWidth : false,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(geometry.documentWidth).toBeLessThanOrEqual(768);
  expect(geometry.chromeFits).toBe(true);
  expect(geometry.addressWidth).toBeGreaterThanOrEqual(96);
});

test("uses one real Chromium action per mobile keyboard control key", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountCompactBrowserChrome(page);

  const keyboard = page.getByTestId("shared-browser-mobile-keyboard");
  await keyboard.evaluate((element) => {
    element.style.setProperty("display", "flex", "important");
  });
  await page.getByTestId("shared-browser-mobile-keyboard-open").click();
  const input = page.getByTestId("shared-browser-mobile-keyboard-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("autocapitalize", "none");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("spellcheck", "false");
  // The app input reserves its measured footer; it does not cover the remote
  // surface. This fixture substitutes the transport, not the keyboard control.
  await expect.poll(async () => {
    const viewer = await page.getByTestId("keyboard-layout-viewer").boundingBox();
    const bar = await keyboard.boundingBox();
    return Boolean(viewer && bar && viewer.height > 100 && viewer.y + viewer.height <= bar.y);
  }).toBe(true);

  await input.press("Backspace");
  await input.press("Enter");
  await input.pressSequentially("a");

  const messages = await page.evaluate(
    () =>
      (window as Window & { __remoteKeyboardMessages?: Record<string, unknown>[] })
        .__remoteKeyboardMessages ?? [],
  );
  expect(messages.filter((message) => message.type === "key")).toEqual([
    expect.objectContaining({ kind: "rawKeyDown", key: "Backspace" }),
    expect.objectContaining({ kind: "keyUp", key: "Backspace" }),
    expect.objectContaining({ kind: "keyDown", key: "Enter", text: "\r" }),
    expect.objectContaining({ kind: "keyUp", key: "Enter", text: "" }),
  ]);
  expect(messages.filter((message) => message.type === "text")).toEqual([
    { type: "text", text: "a" },
  ]);
  await page.getByTestId("shared-browser-mobile-keyboard-close").click();
  await expect.poll(async () => (await page.getByTestId("keyboard-layout-viewer").boundingBox())?.height).toBe(240);
});

test("keeps Unicode remote input out of a previously focused local editor", async ({ page }) => {
  // Use the production binding and actual Chromium pointer/keyboard defaults.
  // The message sink is simulated; remote transport/authorization is covered
  // by the separate Shared runtime tests.
  const fixturePath = "/__remote-browser-text-input-fixture__";
  await page.route(`**${fixturePath}`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8" />
      <style>body { font: 16px sans-serif; } canvas { display: block; border: 2px solid #888; }
      [contenteditable] { margin-top: 20px; padding: 16px; border: 1px solid #888; }</style>
      </head><body>
      <canvas id="remote" tabindex="0" width="600" height="240" aria-label="Remote page"></canvas>
      <div id="composer" contenteditable="true" aria-label="Local draft">Local draft stays here.</div>
      <script type="module">
        import { attachRemoteBrowserInput } from "/src/screens/studio/components/remoteBrowserInput.ts";
        window.__inputMessages = [];
        window.__beforeInputs = [];
        window.__inputEnabled = true;
        const canvas = document.getElementById("remote");
        attachRemoteBrowserInput(canvas, {
          enabled: () => window.__inputEnabled,
          getViewport: () => ({ width: 600, height: 240, deviceWidth: 600, deviceHeight: 240, dpr: 1 }),
          send: (message) => window.__inputMessages.push(message),
        });
        canvas.addEventListener("beforeinput", (event) => window.__beforeInputs.push({
          inputType: event.inputType, canceled: event.defaultPrevented, cancelable: event.cancelable,
        }));
        window.__inputReady = true;
      </script></body></html>`,
  }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixturePath);
  await expect.poll(() => page.evaluate(() => Boolean(
    (window as Window & { __inputReady?: boolean }).__inputReady,
  ))).toBe(true);
  const composer = page.locator("#composer");
  const canvas = page.locator("#remote");
  await composer.click();
  await canvas.click();
  await expect(canvas).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.anchorNode?.parentElement
    ?.closest("[contenteditable]")?.id)).toBe("composer");

  const phrase = "Desktop to phone — inert test";
  await page.keyboard.type(phrase);
  await expect(composer).toHaveText("Local draft stays here.");
  await expect(canvas).toBeFocused();
  const messages = await page.evaluate(() => (
    window as Window & { __inputMessages?: Array<{ type: string; kind?: string; text?: string }> }
  ).__inputMessages ?? []);
  expect(messages.filter((message) => message.type === "text" ||
    (message.type === "key" && message.kind === "keyDown"))
    .map((message) => message.text ?? "").join("")).toBe(phrase);
  expect(await page.evaluate(() => (
    window as Window & { __beforeInputs?: unknown[] }
  ).__beforeInputs)).toEqual([
    { inputType: "insertText", canceled: true, cancelable: true },
  ]);

  await page.evaluate(() => {
    (window as Window & { __inputEnabled?: boolean }).__inputEnabled = false;
  });
  await page.keyboard.insertText("— inert blocked");
  await expect(composer).toHaveText("Local draft stays here.");
  await expect(canvas).toBeFocused();
  expect(await page.evaluate(() => (
    window as Window & { __inputMessages?: unknown[] }
  ).__inputMessages?.length)).toBe(messages.length);
  expect(await page.evaluate(() => (
    window as Window & { __beforeInputs?: unknown[] }
  ).__beforeInputs)).toEqual([
    { inputType: "insertText", canceled: true, cancelable: true },
    { inputType: "insertText", canceled: true, cancelable: true },
  ]);
  expect(errors).toEqual([]);
});
