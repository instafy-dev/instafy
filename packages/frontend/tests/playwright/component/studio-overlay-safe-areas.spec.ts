import { expect, test, type Locator, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__studio-overlay-safe-areas-fixture__";

async function mountOverlays(page: Page): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { StudioDialogModal } from "/src/components/aria/StudioModal.tsx";
    import { HostedRuntimePromptDialog } from "/src/runtime/components/HostedRuntimePromptDialog.tsx";
    import { BuildLogOverlay } from "/src/screens/studio/components/BuildLogOverlay.tsx";
    import { ProjectLauncher } from "/src/screens/studio/components/ProjectLauncher.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const noop = () => {};
    createRoot(document.getElementById("root")).render(
      h(React.Fragment, null,
        h(ProjectLauncher, {
          open: true,
          onClose: noop,
          onCreateBlank: noop,
          onCreateFromGithub: async () => ({ success: true }),
        }),
        h(StudioDialogModal, {
          isOpen: true,
          className: "p-0",
          modalClassName: "studio-safe-area-modal-panel",
          "data-testid": "studio-modal-overlay",
          dialogAriaLabel: "Safe area fixture",
        }, h("div", { className: "p-6" }, "Shared modal")),
        h(HostedRuntimePromptDialog, {
          runtimes: [],
          onUseExisting: noop,
          onLaunchNew: noop,
          onCancel: noop,
        }),
        h(BuildLogOverlay, {
          logs: [],
          onClear: noop,
          onClose: noop,
        }),
      ),
    );
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script>
      document.documentElement.style.setProperty("--safe-area-inset-top", "24px");
      document.documentElement.style.setProperty("--safe-area-inset-right", "48px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "18px");
      document.documentElement.style.setProperty("--safe-area-inset-left", "27px");
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
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
    timeout: 20_000,
  });
  expect(errors, errors.join("; ")).toEqual([]);
}

async function expectPadding(
  locator: Locator,
  expected: { top: number; right: number; bottom: number; left: number },
): Promise<void> {
  await expect(locator).toHaveCSS("padding-top", `${expected.top}px`);
  await expect(locator).toHaveCSS("padding-right", `${expected.right}px`);
  await expect(locator).toHaveCSS("padding-bottom", `${expected.bottom}px`);
  await expect(locator).toHaveCSS("padding-left", `${expected.left}px`);
}

async function expectInsideSafeArea(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(27);
  expect(box!.x + box!.width).toBeLessThanOrEqual(780 - 48);
  expect(box!.y).toBeGreaterThanOrEqual(24);
  expect(box!.y + box!.height).toBeLessThanOrEqual(360 - 18);
}

test("fixed Studio overlays stay inside asymmetric landscape safe areas", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 360 });
  await mountOverlays(page);

  const sharedModal = page.getByTestId("studio-modal-overlay");
  const hostedRuntime = page.getByTestId("hosted-runtime-existing-dialog");
  const buildLogs = page.getByTestId("build-log-overlay");
  const projectLauncher = page.getByTestId("project-launcher-overlay");

  await expectPadding(sharedModal, { top: 24, right: 48, bottom: 18, left: 27 });
  await expectPadding(hostedRuntime, { top: 24, right: 48, bottom: 18, left: 27 });
  await expectPadding(buildLogs, { top: 24, right: 48, bottom: 18, left: 27 });
  await expectPadding(projectLauncher, { top: 32, right: 48, bottom: 32, left: 27 });

  await expectInsideSafeArea(page.locator(".studio-safe-area-modal-panel"));
  await expectInsideSafeArea(hostedRuntime.locator(":scope > *"));
  await expectInsideSafeArea(page.getByTestId("build-log-panel"));

  const launcherPanel = projectLauncher.getByRole("dialog");
  const launcherBox = await launcherPanel.boundingBox();
  expect(launcherBox).not.toBeNull();
  expect(launcherBox!.x).toBeGreaterThanOrEqual(27);
  expect(launcherBox!.x + launcherBox!.width).toBeLessThanOrEqual(780 - 48);
  expect(launcherBox!.y).toBeGreaterThanOrEqual(32);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(780);
});
