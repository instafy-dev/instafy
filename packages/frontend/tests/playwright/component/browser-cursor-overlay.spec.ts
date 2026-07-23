import { test, expect, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

// Real-browser coverage for the AI cursor overlay's coordinate mapping and the
// action ticker. jsdom returns zero geometry, so the viewport→framebuffer→canvas
// math can only be verified in a real browser. Mounts the real components against
// the dev server with a fake canvas of known geometry — no backend needed.

const FIXTURE_PATH = "/__browser-cursor-fixture__";

test.describe("browser action cursor overlay + ticker", () => {
  test("maps a viewport click to the correct on-canvas position and captions it", async ({
    page,
  }) => {
    const deps = await resolveViteReactDependencies(page);

    // Stage 640x400. A DPR-2 framebuffer 2560x1440 renders letterboxed at
    // scale 0.25 → 640x360 with a 20px top band. Click (400,300) in a
    // 1280x640 CSS viewport: physical toolbar = 1440-(640*2) = 160,
    // fbY = 160+(300*2) = 760 → left = 800*0.25 = 200,
    // top = 20 + 760*0.25 = 210.
    const main = `
      import "/src/styles/tailwind.css";
      import ReactNS from "${deps.react}";
      import ReactDomClientNS from "${deps.reactDomClient}";
      import { BrowserCursorOverlay } from "/src/screens/studio/components/BrowserCursorOverlay.tsx";
      import { ActionTicker } from "/src/screens/studio/components/ActionTicker.tsx";
      const React = ReactNS.default ?? ReactNS;
      const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
      const h = React.createElement;

      const click = { seq: 7, ts: 1, type: "click", label: 'Click "Apply filter"',
        url: "https://x.test", x: 400, y: 300, viewportW: 1280, viewportH: 640 };

      function Fixture() {
        const containerRef = React.useRef(null);
        const [ready, setReady] = React.useState(false);
        React.useEffect(() => { setReady(true); }, []);
        return h("div", { style: { position: "relative", width: "640px", height: "400px", background: "#111" } },
          // The surface box fills the stage; object-fit geometry must exclude
          // the 20px top/bottom gutters from cursor placement.
          h("div", { ref: containerRef, style: { position: "absolute", inset: 0 } },
            h("canvas", { width: 2560, height: 1440,
              style: { width: "640px", height: "400px", position: "absolute", left: "0px", top: "0px", objectFit: "contain" } })),
          ready ? h(BrowserCursorOverlay, { containerRef, latestClick: click, renderScale: 2 }) : null,
          h(ActionTicker, { actions: [click] }));
      }
      createRoot(document.getElementById("root")).render(h(Fixture));
      window.__mounted = true;`;

    const html = `<!doctype html><html><head><meta charset="utf-8" />
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

    const js = (body: string) => ({ contentType: "application/javascript", body });
    await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(FIXTURE_PATH);
    await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
      timeout: 20_000,
    });

    const cursor = page.locator('[data-testid="browser-cursor"]');
    await expect(cursor).toBeVisible();
    const box = await cursor.evaluate((el) => ({
      left: parseFloat((el as HTMLElement).style.left),
      top: parseFloat((el as HTMLElement).style.top),
    }));
    // Allow a couple px of sub-pixel rounding slack.
    expect(box.left).toBeGreaterThan(197);
    expect(box.left).toBeLessThan(203);
    expect(box.top).toBeGreaterThan(207);
    expect(box.top).toBeLessThan(213);

    // The ticker captions the latest action.
    await expect(page.getByTestId("browser-action-ticker")).toContainText("Apply filter");
    expect(errors, errors.join("; ")).toEqual([]);
  });
});
