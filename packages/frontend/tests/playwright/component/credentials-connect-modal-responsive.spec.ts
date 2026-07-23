import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__credentials-connect-modal-responsive-fixture__";

async function mountCredentialsConnectModal(
  page: Page,
  options: { desktopLike: boolean },
): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { CredentialsConnectModal } from "/src/screens/studio/components/CredentialsConnectModal.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const noop = () => {};
    const fileInputRef = React.createRef();

    function Fixture() {
      const [showAdvanced, setShowAdvanced] = React.useState(false);
      const [labelDraft, setLabelDraft] = React.useState("");
      return h(CredentialsConnectModal, {
        canManageAiConnections: true,
        canUseDesktopConnect: false,
        desktopCodexAuthJsonStatus: null,
        connectModalOpen: true,
        connectModalStep: "codex",
        connectPending: false,
        deviceAuthBusy: false,
        deviceAuthCompleting: false,
        apiKeyPendingProvider: null,
        showAdvanced,
        labelDraft,
        deepseekApiKeyDraft: "",
        deepseekLabelDraft: "",
        zaiApiKeyDraft: "",
        zaiLabelDraft: "",
        geminiApiKeyDraft: "",
        deviceAuthError: null,
        deviceAuthProvider: null,
        deviceAuthSession: null,
        fileInputRef,
        onClose: noop,
        onBack: noop,
        onStepChange: noop,
        onShowAdvancedChange: setShowAdvanced,
        onLabelDraftChange: setLabelDraft,
        onDeepseekApiKeyDraftChange: noop,
        onDeepseekLabelDraftChange: noop,
        onZaiApiKeyDraftChange: noop,
        onZaiLabelDraftChange: noop,
        onGeminiApiKeyDraftChange: noop,
        onConnectCodex: noop,
        onBeginDeviceAuth: noop,
        onCancelDeviceAuthSession: noop,
        onTriggerUpload: noop,
        onUploadFile: noop,
        onConnectApiKey: async () => true,
      });
    }

    createRoot(document.getElementById("root")).render(h(Fixture));
    window.__mounted = true;`;

  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <script>
      const nativeMatchMedia = window.matchMedia.bind(window);
      if (!${JSON.stringify(options.desktopLike)}) {
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: async (payload) => {
            if (window.__desktopSetupShareBehavior === "cancel") {
              throw new Error("Share sheet dismissed by the user");
            }
            if (window.__desktopSetupShareBehavior === "fail") {
              throw new Error("Share service failed");
            }
            window.__desktopSetupShare = payload;
          },
        });
      }
      window.matchMedia = (query) => {
        if (query === "(pointer: fine)" || query === "(hover: hover)") {
          return {
            matches: ${JSON.stringify(options.desktopLike)},
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          };
        }
        return nativeMatchMedia(query);
      };
    </script>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body class="bg-slate-950"><div id="root"></div></body></html>`;

  await page.route(`**${FIXTURE_PATH}`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: main }),
  );

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
    timeout: 20_000,
  });
  expect(errors, errors.join("; ")).toEqual([]);
}

async function openAdvancedOptions(page: Page): Promise<void> {
  const toggle = page.getByTestId("credentials-codex-advanced-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("credentials-codex-advanced-options")).toBeVisible();
}

test.describe("advanced AI connection layout", () => {
  test("keeps the narrow modal stacked in a wide desktop viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mountCredentialsConnectModal(page, { desktopLike: true });
    await openAdvancedOptions(page);

    const panel = page.getByTestId("credentials-codex-advanced-options");
    const labelInput = page.getByTestId("credentials-codex-label-input");
    const chooseAuthJson = page.getByTestId("credentials-codex-auth-json-upload");
    const [panelBox, inputBox, uploadBox] = await Promise.all([
      panel.boundingBox(),
      labelInput.boundingBox(),
      chooseAuthJson.boundingBox(),
    ]);

    expect(panelBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(uploadBox).not.toBeNull();
    expect(inputBox!.width).toBeGreaterThan(400);
    expect(uploadBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height + 10);
    expect(uploadBox!.x).toBeGreaterThanOrEqual(panelBox!.x + 10);
    expect(uploadBox!.x + uploadBox!.width).toBeLessThanOrEqual(
      panelBox!.x + panelBox!.width - 10,
    );

    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="credentials-codex-advanced-options"]',
      );
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        dialog: dialog?.getBoundingClientRect().toJSON(),
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
      };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.panelOverflow).toBeLessThanOrEqual(1);
    expect(geometry.dialog?.right).toBeLessThanOrEqual(1024);
  });

  test("keeps advanced options reachable and touch-friendly on a short phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await mountCredentialsConnectModal(page, { desktopLike: false });
    await openAdvancedOptions(page);

    const panel = page.getByTestId("credentials-codex-advanced-options");
    const installDesktop = page.getByTestId("credentials-codex-desktop-install");
    await page.waitForFunction(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-testid="credentials-codex-card"]',
      );
      const body = card?.parentElement;
      const action = document.querySelector<HTMLElement>(
        '[data-testid="credentials-codex-desktop-install"]',
      );
      return Boolean(
        body && action && action.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom,
      );
    });
    await expect(installDesktop).toBeVisible();
    await expect(installDesktop).toHaveAttribute("href", "https://instafy.dev/install");
    await expect(installDesktop).toHaveText(/Send setup link/);
    await expect(page.getByTestId("credentials-codex-auth-json-upload")).toHaveCount(0);
    await expect(page.getByTestId("credentials-codex-label-input")).toHaveCount(0);
    await expect(page.getByTestId("credentials-codex-auth-json-input")).toHaveCount(0);

    const [panelBox, actionBox] = await Promise.all([
      panel.boundingBox(),
      installDesktop.boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.height).toBeGreaterThanOrEqual(44);
    expect(actionBox!.width).toBeGreaterThanOrEqual(panelBox!.width - 26);

    const geometry = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="credentials-codex-card"]');
      const body = card?.parentElement;
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const dialogBounds = dialog?.getBoundingClientRect();
      const bodyBounds = body?.getBoundingClientRect();
      const actionButton = document.querySelector<HTMLElement>(
        '[data-testid="credentials-codex-desktop-install"]',
      );
      const actionBounds = actionButton?.getBoundingClientRect();
      return {
        bodyClientHeight: body?.clientHeight ?? 0,
        bodyScrollHeight: body?.scrollHeight ?? 0,
        bodyScrollTop: body?.scrollTop ?? 0,
        bodyBottom: bodyBounds?.bottom ?? -1,
        dialogTop: dialogBounds?.top ?? -1,
        dialogBottom: dialogBounds?.bottom ?? -1,
        documentWidth: document.documentElement.scrollWidth,
        actionBottom: actionBounds?.bottom ?? -1,
      };
    });
    expect(geometry.bodyScrollHeight).toBeGreaterThanOrEqual(geometry.bodyClientHeight);
    if (geometry.bodyScrollHeight > geometry.bodyClientHeight) {
      expect(geometry.bodyScrollTop).toBeGreaterThan(0);
    }
    expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.bodyBottom);
    expect(geometry.dialogTop).toBeGreaterThanOrEqual(16);
    expect(geometry.dialogBottom).toBeLessThanOrEqual(640 - 16);
    expect(geometry.documentWidth).toBeLessThanOrEqual(360);

    await installDesktop.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as { __desktopSetupShare?: { url?: string } }).__desktopSetupShare?.url,
        ),
      )
      .toBe("https://instafy.dev/install");
    const sharePayload = await page.evaluate(
      () =>
        (window as { __desktopSetupShare?: { text?: string; title?: string; url?: string } })
          .__desktopSetupShare,
    );
    expect(sharePayload).toMatchObject({
      title: "Set up Instafy Desktop",
      text: expect.stringContaining("sign in to Instafy"),
      url: "https://instafy.dev/install",
    });

    await page.evaluate(() => {
      (window as { __desktopSetupShareBehavior?: string }).__desktopSetupShareBehavior = "cancel";
    });
    await installDesktop.click();
    await expect(installDesktop).toHaveText(/Send setup link/);

    await page.evaluate(() => {
      (window as { __desktopSetupShareBehavior?: string }).__desktopSetupShareBehavior = "fail";
    });
    await installDesktop.click();
    await expect(installDesktop).toHaveText(/Open Desktop setup/);
    await expect(page.getByRole("status")).toContainText("Sharing was unavailable");
  });
});
