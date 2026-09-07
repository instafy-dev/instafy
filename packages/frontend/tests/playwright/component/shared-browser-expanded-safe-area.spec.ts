import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__shared-browser-expanded-safe-area__";
type Insets = { top: number; right: number; bottom: number; left: number };

async function mountBrowserSession(page: Page, presentation: "docked" | "modal") {
  const deps = await resolveViteReactDependencies(page);
  // Stub only controller boundaries. The complete production modal, chrome,
  // expand control, viewport and React Aria dialog render in real Chromium.
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
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { BrowserSessionModal } from "/src/screens/studio/components/BrowserSessionModal.tsx";
    import { BrowserTransportSelector } from "/src/screens/studio/components/PersonalBrowserSurface.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    function Fixture() {
      const [open, setOpen] = React.useState(true);
      return h("main", { style: { width: "100%", height: "100dvh" } },
        h(BrowserSessionModal, {
          isOpen: open, onOpenChange: setOpen, presentation: ${JSON.stringify(presentation)},
          fillContainer: true, projectId: null, preferRuntimeId: null,
          sharedBrowserViewerKind: "cdp-screencast", sharedBrowserAvailableViewerKinds: ["cdp-screencast"],
          toolbarLeading: h(BrowserTransportSelector, {
            checked: true, compact: true, mode: "shared", personalAvailable: true, onModeChange: () => {},
          }),
          sharedBrowserChrome: {
            compact: true, resolved: true, pendingAction: null, error: null,
            pages: [{ id: "fixture-page", url: "https://fixture.example.test", host: "fixture.example.test", label: "Fixture", title: "Fixture", isActive: true }],
            onNavigate: () => {}, onBack: () => {}, onForward: () => {}, onReload: () => {}, onFocusPage: () => {}, onClearError: () => {},
          },
        }),
      );
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>html,body,#root{margin:0;width:100%;height:100%;min-width:0}</style>
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script></head><body><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("shared-browser-chrome")).toBeVisible();
}

async function setInsets(page: Page, insets: Insets) {
  await page.evaluate((value) => {
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${value[edge]}px`);
    }
  }, insets);
}

const layouts = [
  { name: "web", width: 1000, height: 800, top: 0, right: 0, bottom: 0, left: 0 },
  { name: "macOS", width: 1000, height: 800, top: 38, right: 0, bottom: 0, left: 0 },
  { name: "mobile", width: 390, height: 844, top: 59, right: 11, bottom: 34, left: 13 },
];

for (const presentation of ["docked", "modal"] as const) {
  for (const layout of layouts) {
    test(`expanded Shared ${presentation} respects ${layout.name} safe areas`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await mountBrowserSession(page, presentation);
      await setInsets(page, layout);
      const expand = page.getByTestId("browser-session-fullscreen-toggle");
      await expect(expand).toHaveAttribute("aria-expanded", "false");
      await expand.click();
      await expect(expand).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("dialog", { name: "Browser session", exact: true })).toBeVisible();

      const assertGeometry = async (size: typeof layout | { width: number; height: number } & Insets) => {
        await expect.poll(() => page.evaluate(() => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Browser session"]')!;
          const panel = dialog.firstElementChild!;
          const chrome = document.querySelector<HTMLElement>('[data-testid="shared-browser-chrome"]')!;
          const viewport = document.querySelector<HTMLElement>('[data-testid="browser-session-viewport"]')!;
          const bounds = (node: Element) => {
            const rect = node.getBoundingClientRect();
            return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
          };
          return {
            dialog: bounds(dialog), panel: bounds(panel), chromeTop: chrome.getBoundingClientRect().top,
            viewportBottom: viewport.getBoundingClientRect().bottom,
            documentWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight,
            paintedBackground: getComputedStyle(dialog.parentElement!).backgroundColor !== "rgba(0, 0, 0, 0)",
          };
        })).toEqual({
          dialog: { top: 0, right: size.width, bottom: size.height, left: 0 },
          panel: { top: size.top, right: size.width - size.right, bottom: size.height - size.bottom, left: size.left },
          chromeTop: size.top, viewportBottom: size.height - size.bottom,
          documentWidth: size.width, documentHeight: size.height, paintedBackground: true,
        });
      };
      await assertGeometry(layout);
      const screenshot = testInfo.outputPath(`expanded-shared-${presentation}-${layout.name}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach("Full expanded Shared modal", { path: screenshot, contentType: "image/png" });

      if (layout.name === "mobile") {
        const landscape = { width: 844, height: 390, top: 0, right: 59, bottom: 21, left: 59 };
        await page.setViewportSize(landscape);
        await setInsets(page, landscape);
        await assertGeometry(landscape);
        await page.setViewportSize({ width: layout.width, height: layout.height });
      }
      // Native inset updates do not require a remount; ordinary web browsers
      // recover every pixel when no system chrome needs space.
      await setInsets(page, { top: 0, right: 0, bottom: 0, left: 0 });
      await assertGeometry({ width: layout.width, height: layout.height, top: 0, right: 0, bottom: 0, left: 0 });
      await expand.click();
      await expect(expand).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("shared-browser-chrome")).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Browser session", exact: true })).toHaveCount(presentation === "modal" ? 1 : 0);
      expect(errors).toEqual([]);
    });
  }
}
