import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__mobile-sidebar-safe-area-fixture__";

async function mountSidebar(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { StudioMobileSidebarOverlay } from "/src/screens/studio/components/StudioMobileSidebarOverlay.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    function Fixture() {
      const [open, setOpen] = React.useState(true);
      return open ? h(StudioMobileSidebarOverlay, { onClose: () => setOpen(false) },
        h("nav", { "data-testid": "sidebar-controls", style: {
          width: "256px", height: "100%", display: "flex", flexDirection: "column",
        } },
          h("button", { style: { height: "44px" } }, "Collapse"),
          h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" } },
            h("div", { style: { height: "1000px" } }, "Scrollable navigation")),
          h("button", { style: { height: "44px", flexShrink: 0 } }, "Profile"),
        )) : h("p", null, "Closed");
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("mobile-sidebar-surface")).toBeVisible();
}

for (const dark of [false, true]) {
  test(`paints mobile drawer to every edge while controls clear safe areas (${dark ? "dark" : "light"})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 393, height: 852 });
    await mountSidebar(page);

    // Rotate and change safe areas without remounting, then restore a zero-inset browser.
    for (const layout of [
      { width: 393, height: 852, top: 59, bottom: 34, left: 0, right: 0 },
      { width: 852, height: 393, top: 0, bottom: 21, left: 59, right: 59 },
      { width: 390, height: 844, top: 0, bottom: 0, left: 0, right: 0 },
    ]) {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.evaluate(({ layout, dark }) => {
        document.documentElement.classList.toggle("dark", dark);
        for (const edge of ["top", "bottom", "left", "right"] as const) {
          document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${layout[edge]}px`);
        }
      }, { layout, dark });

      // Controls follow the coalesced VisualViewport update; the painted
      // surface itself remains CSS-sized and covers the layout viewport.
      await expect.poll(() => page.getByTestId("sidebar-controls").evaluate((nav) =>
        nav.getBoundingClientRect().bottom)).toBe(layout.height - layout.bottom);

      const geometry = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[data-testid="mobile-sidebar-surface"]')!;
        const nav = document.querySelector<HTMLElement>('[data-testid="sidebar-controls"]')!;
        const panelBounds = panel.getBoundingClientRect();
        const navBounds = nav.getBoundingClientRect();
        return {
          panel: { top: panelBounds.top, bottom: panelBounds.bottom, left: panelBounds.left, right: panelBounds.right },
          nav: { top: navBounds.top, bottom: navBounds.bottom, left: navBounds.left },
          // Top/bottom pixels must belong to the painted panel, not the backdrop below it.
          coversTop: panel.contains(document.elementFromPoint(2, 1)),
          coversBottom: panel.contains(document.elementFromPoint(2, window.innerHeight - 1)),
          background: getComputedStyle(panel).backgroundColor,
          scrollHeight: document.documentElement.scrollHeight,
        };
      });
      expect(geometry.panel.top).toBe(0);
      expect(geometry.panel.bottom).toBe(layout.height);
      expect(geometry.panel.left).toBe(0);
      expect(geometry.panel.right).toBeLessThanOrEqual(layout.width - layout.right);
      expect(geometry.nav.top).toBe(layout.top);
      expect(geometry.nav.bottom).toBe(layout.height - layout.bottom);
      expect(geometry.nav.left).toBe(layout.left);
      expect(geometry.coversTop).toBe(true);
      expect(geometry.coversBottom).toBe(true);
      expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(geometry.scrollHeight).toBe(layout.height);
    }

    await page.getByRole("button", { name: "Close sidebar", exact: true }).click({ position: { x: 380, y: 400 } });
    await expect(page.getByTestId("mobile-sidebar-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
