import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__mobile-sidebar-keyboard-fixture__";

async function mountSidebar(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { StudioMobileSidebarOverlay } from "/src/screens/studio/components/StudioMobileSidebarOverlay.tsx";
    import { StudioSidebarMobileDrillIn } from "/src/screens/studio/components/StudioSidebarMobileDrillIn.tsx";
    import { StudioSidebarWorkspaceSwitcher } from "/src/screens/studio/components/StudioSidebarWorkspaceSwitcher.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    function Fixture() {
      const [open, setOpen] = React.useState(true);
      const [drillIn, setDrillIn] = React.useState(true);
      const [searchOpen, setSearchOpen] = React.useState(false);
      const [query, setQuery] = React.useState("");
      const projects = Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: "Fixture space " + index }));
      return open ? h(StudioMobileSidebarOverlay, { onClose: () => setOpen(false) },
        h("nav", { style: { position: "relative", width: "288px", height: "100%" } },
          h(StudioSidebarMobileDrillIn, {
            open: drillIn, testId: "sidebar-project-switcher-menu", title: "Team & spaces",
            backLabel: "Back", backTestId: "sidebar-project-switcher-back", onBack: () => setDrillIn(false),
          }, h(StudioSidebarWorkspaceSwitcher, {
            orgOptions: Array.from({ length: 12 }, (_, index) => ({ key: String(index), name: "Fixture team " + index, label: "Fixture team " + index, slug: null, count: 1 })),
            workspaceOrgKey: "0", onWorkspaceOrgChange: () => { throw new Error("No team action belongs to this fixture"); },
            canSearchSpaces: true, showProjectSearch: searchOpen, workspaceProjectSearchOpen: searchOpen,
            workspaceProjectQuery: query, onWorkspaceProjectQueryChange: setQuery,
            onToggleProjectSearch: () => { setSearchOpen(!searchOpen); setQuery(""); },
            currentOrgProject: null, switcherProjects: projects.filter((project) => project.name.includes(query)),
            onProjectMenuAction: () => { throw new Error("No project action belongs to this fixture"); },
          })),
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
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(FIXTURE_PATH);
}

test("keeps focused sidebar search centered through visual keyboard resize and restores the drawer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 812, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await mountSidebar(page);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-area-inset-top", "50px");
    document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
  });
  await page.getByRole("button", { name: "Search spaces", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search spaces", exact: true });
  await search.click();
  await expect(search).toBeFocused();
  await search.fill("ios-ui-probe");
  // Filtering removes the rows below the field. Reveal must still have actual
  // scroll range; scrollIntoView alone would leave this final row at the bottom.
  await expect(page.getByTestId("sidebar-project-switcher-item-0")).toHaveCount(0);
  await expect(page.getByText("No matching spaces.", { exact: true })).toBeVisible();
  await expect(page.getByText("No spaces yet.", { exact: true })).toHaveCount(0);
  await search.evaluate((element) => { (window as unknown as { fixtureSearch: Element }).fixtureSearch = element; });

  for (const bounds of [
    { height: 475, top: 0, scale: 1 },
    { height: 330.5, top: 60.25, scale: 2 },
  ]) {
    await page.evaluate((bounds) => {
      Object.assign(window.visualViewport!, { height: bounds.height, offsetTop: bounds.top, scale: bounds.scale });
      window.visualViewport!.dispatchEvent(new Event("resize"));
      window.visualViewport!.dispatchEvent(new Event("scroll"));
    }, bounds);
    // Centering may already be true for the previous viewport. Wait for this
    // resize's scheduled layout update before accepting centered geometry.
    await expect.poll(() => page.getByTestId("mobile-sidebar-controls").evaluate(
      (element) => element.getBoundingClientRect().bottom,
    )).toBeCloseTo(bounds.top + bounds.height, 0);
    await expect.poll(() => page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#sidebar-project-switcher-search")!;
      const port = input.closest<HTMLElement>("[data-sidebar-scrollport]")!.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      return Math.abs(field.top + field.height / 2 - port.top - port.height / 2);
    })).toBeLessThan(2);
    const geometry = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#sidebar-project-switcher-search")!;
      const port = input.closest<HTMLElement>("[data-sidebar-scrollport]")!.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>('[data-testid="mobile-sidebar-surface"]')!.getBoundingClientRect();
      const back = document.querySelector<HTMLElement>('[data-testid="sidebar-project-switcher-back"]')!.getBoundingClientRect();
      return {
        portBottom: port.bottom, fieldBottom: field.bottom, fieldTop: field.top, backBottom: back.bottom,
        paintedTop: panel.top, paintedBottom: panel.bottom, layoutHeight: window.innerHeight,
        sameInput: input === (window as unknown as { fixtureSearch: Element }).fixtureSearch,
      };
    });
    expect(geometry.portBottom).toBeLessThanOrEqual(bounds.top + bounds.height + 1);
    expect(geometry.fieldBottom).toBeLessThan(geometry.portBottom - 50);
    expect(geometry.fieldTop).toBeGreaterThan(geometry.backBottom);
    expect(geometry.paintedTop).toBe(0); expect(geometry.paintedBottom).toBe(812);
    expect(geometry.layoutHeight).toBe(812); expect(geometry.sameInput).toBe(true);
    await expect(search).toHaveValue("ios-ui-probe"); await expect(search).toBeFocused();
  }
  await page.screenshot({ path: test.info().outputPath("sidebar-focused-search-visible.png") });
  await search.fill("");
  await expect(page.getByTestId("sidebar-project-switcher-item-0")).toBeVisible();
  await expect(page.getByText("No matching spaces.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear space search", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect.poll(() => page.locator("[data-sidebar-scrollport]").evaluate((port) =>
    (port as HTMLElement).style.getPropertyValue("--sidebar-focused-search-space"))).toBe("");
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 812, offsetTop: 0, scale: 1 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.getByTestId("mobile-sidebar-controls").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(778);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toHaveCount(0);
  await page.getByTestId("mobile-sidebar-overlay").click({ position: { x: 350, y: 400 } });
  await expect(page.getByTestId("mobile-sidebar-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});
