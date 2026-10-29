import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__octo-coin-fixture__";

// Every size Octo's tile is drawn at: the mention picker and thread stacks
// (20, 24), the roster (24, 28), chat avatars (2xs 24, xs 28, sm 32, lg 48)
// and agent avatars (28, 36, 64).
const SIZES = [20, 24, 28, 32, 36, 48, 64] as const;

async function mountOctoCoins(page: Page, theme: "light" | "dark"): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { OctoCoin } from "/src/components/OctoCoin.tsx";
    import { HumanAvatar } from "/src/components/HumanAvatar.tsx";
    import { AgentAvatar } from "/src/components/AgentAvatar.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const sizes = ${JSON.stringify(SIZES)};
    createRoot(document.getElementById("root")).render(
      h("main", { className: "flex flex-col gap-4 bg-white p-6 dark:bg-[var(--color-studio-dark-panel)]" },
        h("div", { className: "flex items-center gap-4" }, ...sizes.map((size) =>
          h("span", { key: size, "data-size": size, style: { width: size + "px", height: size + "px" } },
            h(OctoCoin, { className: "h-full w-full" })))),
        h("div", { className: "flex items-center gap-4" }, ...sizes.map((size) =>
          h("span", { key: size, "data-thinking-size": size, style: { width: size + "px", height: size + "px" } },
            h(OctoCoin, { className: "h-full w-full", motion: "thinking" })))),
        // A person's face and another agent's face: every face shares Octo's
        // light shadow; the agent is the same AI tile, the person a circle.
        // The probe paints the shared shadow token alone.
        h("div", { className: "flex items-center gap-4" },
          h("span", { "data-peer": "human" }, h(HumanAvatar, { userId: "u-ada", displayName: "Ada Person" })),
          h("span", { "data-peer": "agent" }, h(AgentAvatar, { agent: { handle: "reviewer", avatarSeed: "reviewer" } })),
          h("span", { "data-probe": "", className: "block h-6 w-6", style: { boxShadow: "var(--avatar-coin-shadow)" } })),
        // An overlapping avatar stack like the conversation roster (its
        // separator ring sits on each face, each slot in its face's shape):
        // the face after Octo must still cover Octo's right edge.
        h("div", { className: "flex items-center -space-x-1.5", "data-stack": "" },
          h("span", { className: "rounded-[30%] *:ring-1 *:ring-white", "data-stack-item": "octo" },
            h(OctoCoin, { className: "h-6 w-6" })),
          h("span", { className: "rounded-full *:ring-1 *:ring-white", "data-stack-item": "next" },
            h(HumanAvatar, { userId: "u-ben", displayName: "Ben", className: "h-6 w-6 text-xxs" })))));
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, undefined, {
    timeout: 20_000,
  });
  return errors;
}

type CoinReading = {
  size: number;
  background: string;
  border: string;
  position: string;
  after: string;
  /** The tile's corner radius as computed: 30% at every size. */
  radius: string;
  /** The tile's computed box-shadow: the shared coin shadow in light, none in dark. */
  edge: string;
  /** The tile's hairline: a 1px solid outline drawn 1px inside its edge. */
  outline: { style: string; width: string; offset: string; color: string };
  markColor: string;
  /** The tile's inscribed circle (inside the hairline) minus the mark's furthest point, idle and at worst through the thinking cycle. */
  clearance: number;
};

async function readCoins(page: Page, selector: string): Promise<CoinReading[]> {
  return page.evaluate((selector) => {
    const furthest = (svg: SVGSVGElement, cx: number, cy: number) => {
      let max = 0;
      for (const element of svg.querySelectorAll<SVGGeometryElement>("path, circle")) {
        const matrix = element.getScreenCTM();
        if (!matrix) continue;
        const points: DOMPointInit[] = [];
        if (element instanceof SVGCircleElement) {
          const { value: x } = element.cx.animVal;
          const { value: y } = element.cy.animVal;
          const { value: r } = element.r.animVal;
          for (let i = 0; i < 48; i += 1) {
            points.push({ x: x + r * Math.cos((i / 48) * 2 * Math.PI), y: y + r * Math.sin((i / 48) * 2 * Math.PI) });
          }
        } else {
          const length = element.getTotalLength();
          for (let i = 0; i <= 120; i += 1) points.push(element.getPointAtLength((length * i) / 120));
        }
        for (const point of points) {
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          max = Math.max(max, Math.hypot(screen.x - cx, screen.y - cy));
        }
      }
      return max;
    };
    return Array.from(document.querySelectorAll<HTMLElement>(selector), (host) => {
      const coin = host.querySelector<HTMLElement>("[data-octo-coin]")!;
      const svg = coin.querySelector<SVGSVGElement>("svg.octo-mark")!;
      const rect = coin.getBoundingClientRect();
      const radius = rect.width / 2;
      const cx = rect.left + radius;
      const cy = rect.top + radius;
      const style = getComputedStyle(coin);
      const edge = style.boxShadow;
      // The hairline is an outline pulled inside the edge, so it eats into
      // the room the mark has.
      const outline = { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor };
      const hairline = outline.style === "none" ? 0 : Math.max(0, -parseFloat(outline.offset));
      let worst = furthest(svg, cx, cy);
      if (svg.getAttribute("data-octo-animated") === "true") {
        svg.pauseAnimations();
        for (let t = 0; t <= 3; t += 0.1) {
          svg.setCurrentTime(t);
          worst = Math.max(worst, furthest(svg, cx, cy));
        }
      }
      return {
        size: rect.width,
        background: getComputedStyle(coin).backgroundColor,
        border: getComputedStyle(coin).borderTopWidth,
        position: getComputedStyle(coin).position,
        after: getComputedStyle(coin, "::after").content,
        radius: style.borderTopLeftRadius,
        edge,
        outline,
        markColor: getComputedStyle(svg).color,
        clearance: radius - hairline - worst,
      };
    });
  }, selector);
}

// The empty layer Tailwind's shadow stack ends with when a coin has no shadow.
const NO_SHADOW = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";

for (const theme of ["light", "dark"] as const) {
  test(`Octo's tile keeps its ${theme} edge, clear of the mark at every size`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 400 });
    const errors = await mountOctoCoins(page, theme);
    expect(errors).toEqual([]);

    // The shared avatar coin shadow, as the browser computes it.
    const coinShadow = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-probe]")!).boxShadow,
    );
    if (theme === "light") {
      // A whisper of an all-round hairline and a soft, short drop.
      expect(coinShadow).toBe(
        "rgba(15, 23, 42, 0.06) 0px 0px 0px 1px, rgba(15, 23, 42, 0.12) 0px 1px 2px 0px, rgba(15, 23, 42, 0.1) 0px 2px 6px -1px",
      );
    } else {
      // Empty in dark: each coin keeps its own dark edge.
      expect(coinShadow).toBe(NO_SHADOW);
    }

    const idle = await readCoins(page, "[data-size]");
    const thinking = await readCoins(page, "[data-thinking-size]");
    expect(idle.map((coin) => coin.size)).toEqual([...SIZES]);
    for (const coin of [...idle, ...thinking]) {
      // No border, and the tile is not positioned and draws no ::after, so
      // overlapping stacks keep their tree order.
      expect(coin.border).toBe("0px");
      expect(coin.position).toBe("static");
      expect(coin.after).toBe("none");
      // One rule for faces: a 30% rounded square at every size, its hairline
      // a 1px outline drawn just inside the edge.
      expect(coin.radius).toBe("30%");
      expect(coin.outline).toEqual(expect.objectContaining({ style: "solid", width: "1px", offset: "-1px" }));
      // The hairline is the tile's only inset edge: no inset ring.
      expect(coin.edge).not.toContain("inset");
      if (theme === "light") {
        expect(coin.background).toBe("rgb(255, 255, 255)");
        expect(coin.markColor).toBe("rgb(15, 23, 42)");
        // The shared coin shadow and the 14% ink hairline: no brand-ink ring.
        expect(coin.edge.endsWith(coinShadow)).toBe(true);
        expect(coin.outline.color).toBe("rgba(15, 23, 42, 0.14)");
      } else {
        expect(coin.background).toBe("rgb(38, 38, 38)");
        expect(coin.markColor).toBe("rgb(255, 255, 255)");
        expect(coin.edge.endsWith(NO_SHADOW)).toBe(true);
        expect(coin.outline.color).toBe("rgba(255, 255, 255, 0.22)");
      }
    }

    // A person's face and another agent's face share the light shadow, and
    // draw no shadow of their own in dark. The agent wears Octo's tile and
    // hairline; the person stays a circle with no outline.
    const peers = await page.evaluate(() =>
      ["human", "agent"].map((peer) => {
        const style = getComputedStyle(document.querySelector(`[data-peer="${peer}"] > *`)!);
        return { edge: style.boxShadow, radius: style.borderTopLeftRadius, outline: style.outlineStyle, outlineColor: style.outlineColor };
      }),
    );
    for (const peer of peers) {
      expect(peer.edge.endsWith(theme === "light" ? coinShadow : NO_SHADOW)).toBe(true);
    }
    const [human, agent] = peers;
    expect(human.radius).not.toBe("30%");
    expect(parseFloat(human.radius)).toBeGreaterThanOrEqual(16);
    expect(human.outline).toBe("none");
    expect(agent.radius).toBe("30%");
    expect(agent.outline).toBe("solid");
    expect(agent.outlineColor).toBe(theme === "light" ? "rgba(15, 23, 42, 0.14)" : "rgba(255, 255, 255, 0.22)");

    // In the stack the separator ring sits on the tile itself, above its
    // shadow and outside its inside hairline: a clean white edge, in the
    // tile's own corners, with the soft shadow outside it.
    if (theme === "light") {
      const stackEdge = await page.evaluate(
        () => getComputedStyle(document.querySelector('[data-stack-item="octo"] [data-octo-coin]')!).boxShadow,
      );
      expect(stackEdge.indexOf("rgb(255, 255, 255) 0px 0px 0px 1px")).toBeGreaterThan(-1);
      expect(stackEdge.indexOf("rgb(255, 255, 255) 0px 0px 0px 1px")).toBeLessThan(stackEdge.indexOf(coinShadow));
    }
    // In an overlapping stack the next face covers Octo's right edge (tree
    // order), as it does for every other face in the roster.
    const coverer = await page.evaluate(() => {
      const coin = document.querySelector('[data-stack-item="octo"] [data-octo-coin]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(coin.right - 2, coin.top + coin.height / 2);
      return hit?.closest("[data-stack-item]")?.getAttribute("data-stack-item") ?? null;
    });
    expect(coverer).toBe("next");
    // The mark never reaches the tile's inscribed circle (inside the
    // hairline), at rest at every size and through the thinking stroke from
    // 24px up.
    for (const coin of idle) expect(coin.clearance).toBeGreaterThan(1);
    for (const coin of thinking.filter((entry) => entry.size >= 24)) expect(coin.clearance).toBeGreaterThan(0.25);
  });
}
