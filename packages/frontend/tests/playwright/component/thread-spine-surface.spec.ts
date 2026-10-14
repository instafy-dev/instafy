import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

/**
 * A masked thread-spine notch hides the straight stem behind its bend by
 * painting the surface colour over it. When that colour was a hard-coded
 * palette value (`dark:stroke-slate-950`) it drew a near-black strip beside
 * every bend on the charcoal dark Studio surfaces (reported from iOS). This
 * mounts production ChatBubbleRow workflow spines and ThreadSpine notches on
 * the production Studio working surface, plain and as a search-highlighted
 * row, and compares the rendered pixel inside each notch with the surface
 * pixel just beside it.
 */
const FIXTURE_PATH = "/__thread-spine-surface-fixture__";
// The Studio working surface StudioLayout puts behind ChatPanel.
const WORKING_SURFACE_CLASS = "bg-white text-slate-700 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200";

async function mountFixture(page: Page, dark: boolean) {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import "/src/screens/studio/components/DeferredChatMessageRow.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatBubbleRow } from "/src/screens/studio/components/ChatBubbleRow.tsx";
    import { ThreadSpine } from "/src/screens/studio/components/ThreadSpine.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    document.documentElement.classList.toggle("dark", ${dark});
    // One workflow: three assistant rows joined by the outer workflow spine,
    // each bending into its message with a masked notch, and a message entry
    // whose own spine (as ChatActivityEntries/ChatSystemRows draw it) bends
    // beside the bubble. The middle row is the search-highlighted target, as
    // DeferredChatMessageRow marks it.
    function Row({ index, last }) {
      return h(ChatBubbleRow, {
        // The empty avatar gutter continuation rows use (no coin over the bend).
        align: "left", avatar: h("div", { "aria-hidden": "true", className: "h-8 w-8" }),
        workflowSpineActive: true, workflowSpineContinuesBefore: index > 0, workflowSpineContinuesAfter: !last,
      }, h("div", { className: "relative py-1 text-sm" },
        h(ThreadSpine, { tone: "primary", className: "pointer-events-none absolute top-0 h-full left-[-26px]", notches: [{ maskLine: true }] }),
        h("p", null, "Run update " + index), h("p", null, "Checked the ledger and the VAT lines.")));
    }
    function Fixture() {
      return h("main", { className: "${WORKING_SURFACE_CLASS}", style: { minHeight: "100vh", padding: "24px 16px" } },
        h("div", { className: "flex flex-col gap-2.5" },
          h("section", { "data-testid": "surface-plain" }, h(Row, { index: 0 })),
          h("div", { className: "chat-message-row relative w-full rounded-lg", "data-chat-message-target": "true", "data-testid": "surface-highlighted" },
            h(Row, { index: 1 })),
          h("section", null, h(Row, { index: 2, last: true }))));
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body style="margin:0"><div id="root"></div></body></html>`;
  const js = (body: string) => ({ contentType: "application/javascript", body });
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  for (const surface of ["surface-plain", "surface-highlighted"]) {
    await expect(
      page.getByTestId(surface).locator('svg path:nth-of-type(2)').first(),
      errors.join("; "),
    ).toBeAttached();
  }
  return errors;
}

type NotchProbe = { surface: string; stemX: number; midY: number; eraserStroke: string };

async function probeNotches(page: Page): Promise<NotchProbe[]> {
  return page.evaluate(() => {
    const probes: NotchProbe[] = [];
    for (const surface of ["surface-plain", "surface-highlighted"]) {
      const root = document.querySelector(`[data-testid="${surface}"]`)!;
      for (const svg of root.querySelectorAll<SVGSVGElement>('[data-testid="thread-spine"] svg, [data-testid="chat-workflow-spine"] svg')) {
        const paths = svg.querySelectorAll("path");
        if (paths.length < 2) continue;
        // The first path is the notch eraser: "M x y1 L x y2".
        const eraser = paths[0];
        const match = /M\s+([\d.]+)\s+([\d.]+)\s+L\s+[\d.]+\s+([\d.]+)/.exec(eraser.getAttribute("d") ?? "");
        if (!match) continue;
        const box = svg.getBoundingClientRect();
        const viewBoxWidth = svg.viewBox.baseVal.width;
        probes.push({
          surface,
          stemX: box.x + (Number(match[1]) / viewBoxWidth) * box.width,
          midY: box.y + (Number(match[2]) + Number(match[3])) / 2,
          eraserStroke: getComputedStyle(eraser).stroke,
        });
      }
    }
    return probes;
  });
}

async function samplePixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: x - 0.5, y: y - 0.5, width: 1, height: 1 } });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return [data[0], data[1], data[2]] as [number, number, number];
  }, png.toString("base64"));
}

for (const dark of [false, true]) {
  for (const viewport of [
    { name: "phone", width: 390, height: 844, deviceScaleFactor: 3 },
    { name: "desktop", width: 1280, height: 900, deviceScaleFactor: 1 },
  ]) {
    test.describe(() => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor });

      test(`thread spine notches erase to the surface behind them in ${dark ? "dark" : "light"} at ${viewport.width}px`, async ({ page }) => {
        const errors = await mountFixture(page, dark);
        const probes = await probeNotches(page);
        // Each surface holds a workflow-spine notch and a message-spine notch.
        expect(probes.map((probe) => probe.surface).sort()).toEqual([
          "surface-highlighted", "surface-highlighted", "surface-plain", "surface-plain",
        ]);
        for (const probe of probes) {
          // Inside the notch, on the stem column, only the eraser is painted.
          const inside = await samplePixel(page, probe.stemX, probe.midY);
          // Just left of the stem column (outside the eraser's 3.4px stroke) is the bare surface.
          const beside = await samplePixel(page, probe.stemX - 4, probe.midY);
          const delta = Math.max(...inside.map((channel, index) => Math.abs(channel - beside[index])));
          expect(delta, `${probe.surface}: eraser ${probe.eraserStroke} painted rgb(${inside}) on rgb(${beside})`).toBeLessThanOrEqual(2);
        }
        expect(errors).toEqual([]);
      });
    });
  }
}
