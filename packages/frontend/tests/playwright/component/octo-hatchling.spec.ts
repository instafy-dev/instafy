import { expect, test, type Page } from "@playwright/test";

import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__octo-hatchling-fixture__";
const CATALOG = "/src/assistants/localBuiltInAssistantCatalog.ts";

// Every size an AI face is drawn at: thread stacks (20), the roster and the
// mention picker (24), chat avatars (2xs 24, xs 28, sm 32, lg 48) and agent
// avatars (28, 36, 64).
const SIZES = [20, 24, 28, 32, 36, 48, 64] as const;
const FACES = ["1", "2", "3", "4", "5", "6", "7", "8", "unknown"] as const;
/** docs/Brand.md, "Octo's hatchlings": clear tile inside the rounded edge, in tile units of 64. */
const MIN_CLEAR_TILE_UNITS = 9.4;

async function mountHatchlings(page: Page, theme: "light" | "dark"): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { AiFace } from "/src/components/AiFace.tsx";
    import { OctoCoin } from "/src/components/OctoCoin.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const sizes = ${JSON.stringify(SIZES)};
    const faces = ${JSON.stringify(FACES)};
    // A stamped helper wears its numbered face; an AI known only from text
    // wears the hollow one. Every face is asked to think: only Octo may.
    const identity = (face) =>
      face === "unknown" ? { handle: "ben", textOnly: true } : { handle: "helper-" + face, avatarSeed: "hatchling:" + face };
    createRoot(document.getElementById("root")).render(
      h("main", { className: "flex flex-col gap-4 bg-white p-6 dark:bg-[var(--color-studio-dark-panel)]" },
        ...faces.map((face) =>
          h("div", { key: face, className: "flex items-center gap-4" }, ...sizes.map((size) =>
            h("span", { key: size, "data-face": face, "data-size": size, style: { width: size + "px", height: size + "px" } },
              h(AiFace, { identity: identity(face), className: "h-full w-full", motion: "thinking" }))))),
        // Octo's own tile, whose look every hatchling's tile shares.
        h("div", { className: "flex items-center gap-4" }, ...sizes.map((size) =>
          h("span", { key: size, "data-octo-size": size, style: { width: size + "px", height: size + "px" } },
            h(OctoCoin, { className: "h-full w-full" })))),
        // An overlapping stack like the conversation roster's: the separator
        // ring sits on each face, and the next face covers the one before.
        h("div", { className: "flex items-center -space-x-1.5", "data-stack": "" },
          h("span", { className: "rounded-[30%] *:ring-1 *:ring-white", "data-stack-item": "hatchling" },
            h(AiFace, { identity: identity("3"), className: "h-6 w-6" })),
          h("span", { className: "rounded-[30%] *:ring-1 *:ring-white", "data-stack-item": "next" },
            h(AiFace, { identity: identity("5"), className: "h-6 w-6" })))));
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__mounted = true; }));`;

  const html = `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8" />
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
    route.fulfill({ contentType: "application/javascript", body: main }),
  );
  // Inert assistant identities (Octo is "octo"); the faces, their tile and
  // their CSS are production code.
  await page.route(`**${CATALOG}*`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: RUN_STOP_FIXTURE_STUBS[CATALOG] }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, undefined, {
    timeout: 20_000,
  });
  return errors;
}

type Point = { x: number; y: number };

type HatchlingReading = {
  face: string;
  size: number;
  hatchling: string | null;
  background: string;
  border: string;
  position: string;
  after: string;
  radius: string;
  edge: string;
  outline: { style: string; width: string; offset: string; color: string };
  ink: string;
  /** Every painted shape's computed fill. */
  fills: string[];
  /** The dome's computed fill rule: its eyes are holes only under even-odd. */
  domeFillRule: string;
  octoHooks: number;
  animations: number;
  /** The drawing's box as a share of the tile's, and its offsets from the tile's centre. */
  drawing: { width: number; height: number; dx: number; dy: number };
  /** The least distance from any ink to the hairline's inner edge, which follows the tile's 30% corners (CSS px). */
  clearance: number;
  /** The same, from the tile's own rounded edge, in tile units of 64. */
  clearTileUnits: number;
  /** Where the tile must show through (the eyes; the hollow face's inner dome), and whether any shape paints it. */
  holes: Array<Point & { painted: boolean }>;
  /** Where the ink must be (between the eyes; the hollow face's eyes). */
  inked: Array<Point & { painted: boolean }>;
};

async function readHatchlings(page: Page): Promise<HatchlingReading[]> {
  return page.evaluate(() => {
    const shapes = (svg: SVGSVGElement) => Array.from(svg.querySelectorAll<SVGGeometryElement>("path, circle"));
    const toScreen = (svg: SVGSVGElement, point: { x: number; y: number }) => {
      const screen = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    };
    const probe = (svg: SVGSVGElement, point: { x: number; y: number }) => ({
      ...toScreen(svg, point),
      painted: shapes(svg).some((shape) => shape.isPointInFill(new DOMPoint(point.x, point.y))),
    });
    return Array.from(document.querySelectorAll<HTMLElement>("[data-face]"), (host) => {
      const tile = host.firstElementChild as HTMLElement;
      const svg = tile.querySelector<SVGSVGElement>(':scope > svg[data-ai-face="hatchling"]')!;
      const rect = tile.getBoundingClientRect();
      const drawingRect = svg.getBoundingClientRect();
      const style = getComputedStyle(tile);
      const outline = { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor };
      const hairline = outline.style === "none" ? 0 : Math.max(0, -parseFloat(outline.offset));
      // Signed distance inside the tile's rounded square shrunk by `inset`
      // (its corners shrink with it): positive inside.
      const half = rect.width / 2;
      const corner = parseFloat(style.borderTopLeftRadius) / 100 * rect.width;
      const inside = (point: { x: number; y: number }, inset: number) => {
        const qx = Math.abs(point.x - (rect.left + half)) - (half - corner);
        const qy = Math.abs(point.y - (rect.top + half)) - (half - corner);
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
        return corner - inset - outside;
      };
      let clearance = Infinity;
      let clearEdge = Infinity;
      for (const shape of shapes(svg)) {
        const points: DOMPointInit[] = [];
        if (shape instanceof SVGCircleElement) {
          const { value: x } = shape.cx.baseVal;
          const { value: y } = shape.cy.baseVal;
          const { value: r } = shape.r.baseVal;
          for (let i = 0; i < 72; i += 1) {
            points.push({ x: x + r * Math.cos((i / 72) * 2 * Math.PI), y: y + r * Math.sin((i / 72) * 2 * Math.PI) });
          }
        } else {
          const length = shape.getTotalLength();
          for (let i = 0; i <= 400; i += 1) points.push(shape.getPointAtLength((length * i) / 400));
        }
        for (const point of points) {
          const screen = toScreen(svg, { x: point.x ?? 0, y: point.y ?? 0 });
          clearance = Math.min(clearance, inside(screen, hairline));
          clearEdge = Math.min(clearEdge, inside(screen, 0));
        }
      }
      // The eyes: the holes cut in the dome, the last path (M x y a r r 0 1
      // 0 d 0 ...), or the hollow face's two eye dots.
      const dome = Array.from(svg.querySelectorAll("path")).at(-1)!;
      const holes = Array.from(dome.getAttribute("d")!.matchAll(/M([\d.]+) ([\d.]+)a[\d.]+ [\d.]+ 0 1 0 ([\d.]+) 0/g), (match) => ({
        x: Number(match[1]) + Number(match[3]) / 2,
        y: Number(match[2]),
      }));
      const eyeDots = Array.from(svg.querySelectorAll("circle"), (circle) => ({
        x: circle.cx.baseVal.value,
        y: circle.cy.baseVal.value,
        r: circle.r.baseVal.value,
      })).filter(() => host.dataset.face === "unknown");
      const eyes = host.dataset.face === "unknown" ? eyeDots : holes;
      // Two eyes, or a reading the assertions below reject.
      const between = eyes.length === 2 ? { x: (eyes[0].x + eyes[1].x) / 2, y: (eyes[0].y + eyes[1].y) / 2 } : { x: NaN, y: NaN };
      return {
        face: host.dataset.face!,
        size: rect.width,
        hatchling: svg.getAttribute("data-hatchling"),
        background: style.backgroundColor,
        border: style.borderTopWidth,
        position: style.position,
        after: getComputedStyle(tile, "::after").content,
        radius: style.borderTopLeftRadius,
        edge: style.boxShadow,
        outline,
        ink: getComputedStyle(svg).color,
        fills: shapes(svg).map((shape) => getComputedStyle(shape).fill),
        domeFillRule: getComputedStyle(dome).fillRule,
        octoHooks: tile.querySelectorAll("[data-octo-coin], .octo-mark, [data-octo-motion]").length + (tile.hasAttribute("data-octo-coin") ? 1 : 0),
        animations: tile.querySelectorAll("animate, animateTransform").length,
        drawing: {
          width: drawingRect.width / rect.width,
          height: drawingRect.height / rect.height,
          dx: drawingRect.left + drawingRect.width / 2 - (rect.left + half),
          dy: drawingRect.top + drawingRect.height / 2 - (rect.top + half),
        },
        clearance,
        clearTileUnits: (clearEdge * 64) / rect.width,
        holes:
          host.dataset.face === "unknown"
            ? // Inside the hollow dome, above the eyes.
              [probe(svg, { x: between.x, y: between.y - 2 * (eyeDots[0]?.r ?? 0) })]
            : holes.map((hole) => probe(svg, hole)),
        inked: host.dataset.face === "unknown" ? eyeDots.map((dot) => probe(svg, dot)) : [probe(svg, between)],
      };
    });
  });
}

/** The colour of the device pixel under a CSS point, read from a screenshot. */
async function samplePixel(page: Page, point: Point): Promise<string> {
  const png = await page.screenshot({ clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 } });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, png.toString("base64"));
}

// The empty layer Tailwind's shadow stack ends with when a tile has no shadow.
const NO_SHADOW = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";
const COLORS = {
  light: { tile: "rgb(255, 255, 255)", ink: "rgb(15, 23, 42)", hairline: "rgba(15, 23, 42, 0.14)" },
  dark: { tile: "rgb(38, 38, 38)", ink: "rgb(255, 255, 255)", hairline: "rgba(255, 255, 255, 0.22)" },
} as const;

for (const theme of ["light", "dark"] as const) {
  test(`Octo's hatchlings sit on Octo's ${theme} tile in one ink, clear of its corners at every size`, async ({ page }, testInfo) => {
    // Tall enough for every row, so hit tests and pixel reads stay in view.
    await page.setViewportSize({ width: 900, height: 1200 });
    const errors = await mountHatchlings(page, theme);
    expect(errors).toEqual([]);
    const colors = COLORS[theme];

    const octo = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-octo-size] > [data-octo-coin]"), (coin) => {
        const style = getComputedStyle(coin);
        return { background: style.backgroundColor, edge: style.boxShadow, outline: style.outlineColor, radius: style.borderTopLeftRadius };
      }),
    );
    expect(octo).toHaveLength(SIZES.length);
    const readings = await readHatchlings(page);
    await testInfo.attach(`octo-hatchlings-${theme}`, {
      body: JSON.stringify(readings.map(({ face, size, clearance, clearTileUnits }) => ({ face, size, clearance, clearTileUnits })), null, 2),
      contentType: "application/json",
    });
    expect(readings.map((reading) => `${reading.face}@${reading.size}`)).toEqual(
      FACES.flatMap((face) => SIZES.map((size) => `${face}@${size}`)),
    );

    for (const reading of readings) {
      const where = `face ${reading.face} at ${reading.size}px`;
      expect(reading.hatchling, where).toBe(reading.face);
      // Octo's own tile: the same colour, corners, hairline and shadow.
      expect(reading.background, where).toBe(colors.tile);
      expect(reading.background, where).toBe(octo[0].background);
      expect(reading.radius, where).toBe("30%");
      expect(reading.outline, where).toEqual({ style: "solid", width: "1px", offset: "-1px", color: colors.hairline });
      expect(reading.edge, where).toBe(octo[0].edge);
      expect(reading.edge, where).not.toContain("inset");
      // No border, not positioned, no ::after: a stack keeps its tree order.
      expect(reading.border, where).toBe("0px");
      expect(reading.position, where).toBe("static");
      expect(reading.after, where).toBe("none");
      // One ink, positive on light and reversed on dark, and never Octo's
      // hooks or motion, although the fixture asks every face to think.
      expect(reading.ink, where).toBe(colors.ink);
      expect(new Set(reading.fills), where).toEqual(new Set([colors.ink]));
      expect(reading.octoHooks, where).toBe(0);
      expect(reading.animations, where).toBe(0);
      // Drawn at 75% of the tile, centred, as Octo's mark is.
      expect(reading.drawing.width, where).toBeCloseTo(0.75, 5);
      expect(reading.drawing.height, where).toBeCloseTo(0.75, 5);
      expect(Math.abs(reading.drawing.dx), where).toBeLessThan(0.01);
      expect(Math.abs(reading.drawing.dy), where).toBeLessThan(0.01);
      // No ink reaches the hairline, which follows the 30% corners, and every
      // face keeps its clear tile inside the rounded edge.
      expect(reading.clearance, where).toBeGreaterThan(1);
      expect(reading.clearTileUnits, where).toBeGreaterThanOrEqual(MIN_CLEAR_TILE_UNITS - 0.05);
      // The eyes (the hollow face's inner dome) are holes no shape paints, so
      // the tile shows through; the ink between the eyes (the hollow face's
      // eye dots) is painted.
      expect(reading.domeFillRule, where).toBe("evenodd");
      expect(reading.holes, where).toHaveLength(reading.face === "unknown" ? 1 : 2);
      expect(reading.holes.map((hole) => hole.painted), where).toEqual(reading.holes.map(() => false));
      expect(reading.inked.map((ink) => ink.painted), where).toEqual(reading.inked.map(() => true));
    }
    for (const coin of octo) {
      expect(coin.background).toBe(colors.tile);
      expect(coin.outline).toBe(colors.hairline);
      expect(coin.radius).toBe("30%");
    }
    if (theme === "light") {
      // The shared coin shadow, as on Octo's tile.
      expect(octo[0].edge).toContain("rgba(15, 23, 42, 0.12) 0px 1px 2px 0px");
    } else {
      expect(octo[0].edge.endsWith(NO_SHADOW)).toBe(true);
    }

    // At 64px the eyes are wide enough to read whole pixels: the tile's own
    // colour shows through them, and the ink is painted around them.
    for (const reading of readings.filter((entry) => entry.size === 64)) {
      for (const hole of reading.holes) expect(await samplePixel(page, hole), `face ${reading.face} eye`).toBe(colors.tile);
      for (const ink of reading.inked) expect(await samplePixel(page, ink), `face ${reading.face} ink`).toBe(colors.ink);
    }

    // In the stack the separator ring sits on the tile itself, above its
    // shadow, in the tile's own corners; the next face covers its right edge.
    if (theme === "light") {
      const stackEdge = await page.evaluate(
        () => getComputedStyle(document.querySelector('[data-stack-item="hatchling"] > *')!).boxShadow,
      );
      expect(stackEdge.indexOf("rgb(255, 255, 255) 0px 0px 0px 1px")).toBeGreaterThan(-1);
      expect(stackEdge.indexOf("rgb(255, 255, 255) 0px 0px 0px 1px")).toBeLessThan(stackEdge.indexOf("rgba(15, 23, 42, 0.12) 0px 1px 2px 0px"));
    }
    const coverer = await page.evaluate(() => {
      const tile = document.querySelector('[data-stack-item="hatchling"] > *')!.getBoundingClientRect();
      const hit = document.elementFromPoint(tile.right - 2, tile.top + tile.height / 2);
      return hit?.closest("[data-stack-item]")?.getAttribute("data-stack-item") ?? null;
    });
    expect(coverer).toBe("next");
  });
}
