import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__responsive-dialog-mobile-layout-fixture__";

async function mountCompactDialog(page: Page): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ResponsiveDialogSurface } from "/src/components/aria/ResponsiveDialogSurface.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    createRoot(document.getElementById("root")).render(
      h(ResponsiveDialogSurface, {
        desktop: {},
        mobileFullScreen: false,
        mobile: {
          isOpen: true,
          isDismissable: true,
          dialogAriaLabel: "Compact runtime menu",
          className: "items-stretch justify-stretch",
          style: {
            paddingTop: "calc(var(--instafy-safe-area-inset-top) + 0.75rem)",
            paddingRight: "calc(var(--instafy-safe-area-inset-right) + 0.75rem)",
            paddingBottom: "calc(var(--instafy-safe-area-inset-bottom) + 0.75rem)",
            paddingLeft: "calc(var(--instafy-safe-area-inset-left) + 0.75rem)",
          },
          modalClassName: "h-full w-full max-w-none p-3",
          "data-testid": "responsive-dialog-overlay",
        },
      }, h("div", {
        "data-testid": "tall-dialog-content",
        style: { height: "1200px" },
      }, "Tall Runtime & AI content")),
    );
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <script>
      document.documentElement.style.setProperty("--safe-area-inset-top", "28px");
      document.documentElement.style.setProperty("--safe-area-inset-right", "13px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "24px");
      document.documentElement.style.setProperty("--safe-area-inset-left", "13px");
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
  await page.waitForFunction(
    () => (window as Window & { __mounted?: boolean }).__mounted === true,
    { timeout: 20_000 },
  );
  expect(errors, errors.join("; ")).toEqual([]);
}

test("keeps a tall compact dialog inside Android phone safe areas with internal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await mountCompactDialog(page);

  const overlay = page.getByTestId("responsive-dialog-overlay");
  const dialog = overlay.getByRole("dialog", { name: "Compact runtime menu" });
  await expect(dialog).toBeVisible();

  const geometry = await page.evaluate(() => {
    const overlayElement = document.querySelector<HTMLElement>(
      '[data-testid="responsive-dialog-overlay"]',
    );
    const dialogElement = overlayElement?.querySelector<HTMLElement>('[role="dialog"]');
    const modalElement = dialogElement?.parentElement;
    if (!overlayElement || !dialogElement || !modalElement) {
      return null;
    }
    const bounds = modalElement.getBoundingClientRect();
    const overlayStyle = getComputedStyle(overlayElement);
    return {
      modal: {
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
      },
      overlayPadding: {
        top: Number.parseFloat(overlayStyle.paddingTop),
        right: Number.parseFloat(overlayStyle.paddingRight),
        bottom: Number.parseFloat(overlayStyle.paddingBottom),
        left: Number.parseFloat(overlayStyle.paddingLeft),
      },
      modalClientHeight: modalElement.clientHeight,
      modalScrollHeight: modalElement.scrollHeight,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.overlayPadding).toEqual({
    top: 40,
    right: 25,
    bottom: 36,
    left: 25,
  });
  expect(geometry!.modal.left).toBeGreaterThanOrEqual(25);
  expect(geometry!.modal.right).toBeLessThanOrEqual(360 - 25);
  expect(geometry!.modal.top).toBeGreaterThanOrEqual(40);
  expect(geometry!.modal.bottom).toBeLessThanOrEqual(780 - 36);
  expect(geometry!.modalScrollHeight).toBeGreaterThan(geometry!.modalClientHeight);
  expect(geometry!.documentHeight).toBeLessThanOrEqual(780);
  expect(geometry!.documentWidth).toBeLessThanOrEqual(360);
});
