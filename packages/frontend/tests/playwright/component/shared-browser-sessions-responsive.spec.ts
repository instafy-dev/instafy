import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__shared-browser-sessions-responsive__";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNTIME_IDS = Array.from({ length: 10 }, (_, index) =>
  `${(index + 1).toString().padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
);

// Real production modal, session chooser, save status and React Aria controls.
// Only controller/transport and clipboard boundaries are synthetic: this is
// rendering/touch coverage, not an authenticated multi-device runtime proof.
async function mountSharedSessionPanel(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => {
        (window as Window & { __copiedResumeLink?: string }).__copiedResumeLink = value;
      },
    } });
  });
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      const runtimes = ${JSON.stringify(RUNTIME_IDS)}.map((runtimeId) => ({
        runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle",
        origin: { originId: "origin-" + runtimeId, endpoint: "https://origin.example.test", protocols: ["http"] },
      }));
      export const controllerClient = {
        core: { enabled: true, baseUrl: "" },
        runtimes: {
          fetchStatus: async () => ({ runtimes }),
          ensure: async () => { throw new Error("No allocation in the rendering fixture"); },
        },
        browserProfiles: { fetchStatus: async () => ({ success: true, status: {
          enabled: true, lastSavedAt: "2026-09-07T12:00:00.000Z", savedByRuntimeId: ${JSON.stringify(RUNTIME_IDS[0])},
        } }) },
      };`,
  }));
  await page.route("**/src/services/runtimeController/origins.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "export async function requestOriginAccessToken() { throw new Error('No transport in the rendering fixture'); }",
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
      return h("main", { style: { width: "100%", height: "100dvh" } }, h(BrowserSessionModal, {
        isOpen: open, onOpenChange: setOpen, presentation: "docked", fillContainer: true,
        projectId: ${JSON.stringify(PROJECT_ID)}, currentUserId: "fixture-user",
        preferRuntimeId: null, resumeRuntimeId: ${JSON.stringify(RUNTIME_IDS[0])},
        canControlBrowser: true, sharedBrowserCapabilitiesResolved: false,
        sharedBrowserViewerKind: "cdp-screencast", sharedBrowserAvailableViewerKinds: ["cdp-screencast"],
        toolbarLeading: h(BrowserTransportSelector, {
          checked: true, compact: true, mode: "shared", personalAvailable: true, onModeChange: () => {},
        }),
        sharedBrowserChrome: {
          compact: true, resolved: true, pendingAction: null, error: null,
          pages: [{ id: "fixture-page", url: "https://fixture.example.test", host: "fixture.example.test", label: "Fixture", title: "Fixture", isActive: true }],
          onNavigate: () => {}, onBack: () => {}, onForward: () => {}, onReload: () => {}, onFocusPage: () => {}, onClearError: () => {},
        },
      }));
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

test.use({ hasTouch: true, isMobile: true });

for (const layout of [
  { name: "portrait", width: 390, height: 844, top: 59, right: 0, bottom: 34, left: 0 },
  { name: "short landscape", width: 844, height: 390, top: 0, right: 59, bottom: 21, left: 59 },
]) {
  test(`Shared sessions and saved status stay usable in ${layout.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await mountSharedSessionPanel(page);
    await page.evaluate((insets) => {
      for (const edge of ["top", "right", "bottom", "left"] as const) {
        document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${insets[edge]}px`);
      }
    }, layout);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByTestId("browser-session-fullscreen-toggle").tap();
    await expect(page.getByRole("dialog", { name: "Browser session", exact: true })).toBeVisible();
    const toggle = page.getByTestId("shared-browser-sessions-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: "Shared sessions and resume", exact: true });
    await expect(panel).toBeVisible();
    const link = page.getByRole("textbox", { name: "Shared Browser resume link", exact: true });
    await expect(link).toBeVisible();
    const value = await link.inputValue();
    const locator = new URL(value);
    expect(locator.pathname).toBe("/studio");
    expect([...locator.searchParams.keys()].sort()).toEqual(["browserRuntimeId", "panel", "projectId"]);
    expect(locator.searchParams.get("projectId")).toBe(PROJECT_ID);
    expect(locator.searchParams.get("browserRuntimeId")).toBe(RUNTIME_IDS[0]);

    const controlSizes = await page.getByTestId("shared-browser-session-control").locator("button,input").evaluateAll((controls) => controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return { name: control.getAttribute("aria-label") ?? control.textContent, width: rect.width, height: rect.height };
    }));
    for (const control of controlSizes) {
      expect(control.height, `${control.name} touch target height`).toBeGreaterThanOrEqual(44);
      expect(control.width, `${control.name} touch target width`).toBeGreaterThanOrEqual(44);
    }
    await link.tap();
    await expect(link).toBeFocused();
    expect(await link.evaluate((element) => {
      const input = element as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length };
    }))
      .toEqual({ start: 0, end: value.length, length: value.length });
    await page.getByRole("button", { name: "Copy resume link", exact: true }).tap();
    await expect(panel.getByRole("status").filter({ hasText: "Resume link copied." })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __copiedResumeLink?: string }).__copiedResumeLink)).toBe(value);

    const assertContained = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(layout.width);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(layout.left);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(layout.width - layout.right);
      expect(bounds!.y).toBeGreaterThanOrEqual(layout.top);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(layout.height - layout.bottom);
    };
    await panel.evaluate((element) => { element.scrollTop = 0; });
    await assertContained();
    const topScreenshot = testInfo.outputPath(`shared-sessions-${layout.width}x${layout.height}-links.png`);
    await page.screenshot({ path: topScreenshot, animations: "disabled" });
    await testInfo.attach("Production Shared sessions panel and resume controls", { path: topScreenshot, contentType: "image/png" });

    const profile = page.getByTestId("shared-browser-profile-status");
    await expect(profile).toContainText("Login recovery enabled");
    await expect(profile).toContainText("Saved by this session.");
    await expect(profile).toContainText("not open tabs or unfinished forms");
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await profile.scrollIntoViewIfNeeded();
    await expect(profile).toBeInViewport();
    await expect(profile.getByText("Changes since the last successful save may be lost.", { exact: false })).toBeInViewport();
    await assertContained();
    const bottomScreenshot = testInfo.outputPath(`shared-sessions-${layout.width}x${layout.height}-status.png`);
    await page.screenshot({ path: bottomScreenshot, animations: "disabled" });
    await testInfo.attach("Production saved-browser status reached by scrolling", { path: bottomScreenshot, contentType: "image/png" });

    const lastRuntime = RUNTIME_IDS.at(-1)!;
    await page.getByRole("button", { name: `Resume Shared session ${lastRuntime}`, exact: true }).tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.tap();
    await expect(link).toHaveValue(new RegExp(lastRuntime));
    await expect(profile).toContainText("Not confirmed as a save from this session.");
    await page.getByRole("button", { name: "Refresh sessions", exact: true }).tap();
    await expect(link).toHaveValue(new RegExp(lastRuntime));
    await assertContained();
    expect(errors).toEqual([]);
  });
}
