import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Cub's geometry tests (src/screens/landing/cub/__tests__) lay him out on a
// capture of the landing (fixtures/landingLayout.json). This keeps that
// capture honest: at each captured width the window's top bar (the roster
// coins and the chrome glyphs beside them, measured from the window's top
// right corner) and Cub's perch must still match the page. Text and the
// window's own position depend on fonts, so they are left out. When this
// fails, regenerate the capture with scripts/capture-cub-landing-layout.mjs.

type Rect = { x: number; y: number; w: number; h: number };
type Layout = { mode: string; anchors: { window: Rect; coins: Rect[]; chrome?: Rect[]; octoCoin: number } };

const fixture = JSON.parse(
  readFileSync(new URL("../../src/screens/landing/cub/__tests__/fixtures/landingLayout.json", import.meta.url), "utf8"),
) as Record<string, Layout>;

/** The coins and the glyphs near them, relative to the window's top right corner. */
function topBar(a: Layout["anchors"]): number[][] {
  const right = a.window.x + a.window.w;
  const top = a.window.y;
  const from = Math.min(...a.coins.map((c) => c.x)) - 200;
  const near = (a.chrome ?? []).filter((g) => g.x > from);
  return [...a.coins, ...near].map((r) => [r.x - right, r.y - top, r.w, r.h]);
}

// The capture and drag checks read the page's own modules and dev hooks,
// which only a Vite dev server serves: against anything else (a production
// preview, a deploy) they skip, saying why, rather than fail on a missing /src.
async function skipUnlessVite(request: import("@playwright/test").APIRequestContext) {
  const client = await request.get("/@vite/client", { failOnStatusCode: false }).catch(() => null);
  const vite = !!client && client.ok() && /javascript/.test(client.headers()["content-type"] ?? "");
  test.skip(!vite, "needs a Vite dev server of packages/frontend (no /@vite/client at the target)");
}

test.describe("Cub's landing capture", () => {
  test.beforeEach(async ({ request }) => skipUnlessVite(request));

  for (const [size, layout] of Object.entries(fixture)) {
    test(`still matches the page at ${size}`, async ({ page }) => {
      const [width, height] = size.split("x").map(Number);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
      await page.goto("/?cub-dev=0");
      await page.waitForFunction(() => document.querySelector("[data-cub-mode]"), null, { timeout: 30_000 });
      // The page's own measurement, served by the dev server (a string, so the
      // module import is left to the browser).
      const live = (await page.evaluate(`(async () => {
        const { measureLandingAnchors } = await import("/src/screens/landing/cub/landingCub.ts");
        const hero = document.querySelector('[data-testid="landing-hero"]');
        const layer = document.querySelector('[data-testid="landing-cub-layer"]');
        return { anchors: measureLandingAnchors(hero, layer), mode: layer.dataset.cubMode };
      })()`)) as { anchors: Layout["anchors"] | null; mode: string };
      expect(live.anchors, "the page laid out the window").not.toBeNull();
      expect(live.mode).toBe(layout.mode);
      expect(live.anchors!.octoCoin).toBe(layout.anchors.octoCoin);
      const want = topBar(layout.anchors);
      const got = topBar(live.anchors!);
      expect(got.length).toBe(want.length);
      got.forEach((rect, i) => rect.forEach((v, k) => expect(Math.abs(v - want[i][k]), `${size} top bar rect ${i}`).toBeLessThanOrEqual(2)));
    });
  }
});

// A visitor drag-resizes the window: the page lays out again every frame and
// Cub's perch moves faster than his ease-over spring. He once froze for good
// (the frame loop judged him off screen by where the old layout had drawn
// him). After any drag he must be playing, his clock moving and his body on
// the page.

type CubProbe = { status: string; playing: boolean; simClock: number; body: number[]; box: number[]; mode: string; inner: number };

const probe = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const cub = (window as unknown as { __cub?: { getState(): { status: string; playing: boolean; simClock: number; mode: string }; dev?: { state(): { body: number[]; box: number[] } } } }).__cub!;
    const s = cub.getState();
    const d = cub.dev!.state();
    return { status: s.status, playing: s.playing, simClock: s.simClock, mode: s.mode, body: d.body, box: d.box, inner: window.innerWidth };
  }) as Promise<CubProbe>;

async function drag(page: import("@playwright/test").Page, widths: number[]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(16);
  }
}

async function expectBack(page: import("@playwright/test").Page, label: string) {
  const before = await probe(page);
  await page.waitForTimeout(1_500);
  const after = await probe(page);
  expect(after.playing, `${label}: playing`).toBe(true);
  expect(after.simClock - before.simClock, `${label}: his clock moves`).toBeGreaterThan(0.5);
  expect(after.box[0] * after.box[1], `${label}: drawn`).toBeGreaterThan(0);
  expect(after.body[0], `${label}: body on the page`).toBeGreaterThan(0);
  expect(after.body[0], `${label}: body on the page`).toBeLessThan(after.inner);
}

test.describe("Cub through a drag-resize", () => {
  test.beforeEach(async ({ page, request }) => {
    await skipUnlessVite(request);
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
    await page.goto("/?cub-dev=0");
    await page.waitForFunction(() => {
      const s = (window as unknown as { __cub?: { getState(): { status: string } } }).__cub?.getState();
      return !!s && s.status !== "wait";
    }, null, { timeout: 30_000 });
    const status = await page.evaluate(() => (window as unknown as { __cub: { getState(): { status: string } } }).__cub.getState().status);
    test.skip(status !== "on", "Cub animates only with WebGL2; this browser shows his still");
    await page.waitForTimeout(1_500);
  });

  for (const to of [1000, 700]) {
    test(`comes back after a drag from 1440 to ${to} px in 37 px steps`, async ({ page }) => {
      const widths: number[] = [];
      for (let width = 1440 - 37; width > to; width -= 37) widths.push(width);
      await drag(page, [...widths, to]);
      await expectBack(page, `1440 to ${to}`);
    });
  }

  test("comes back after random drags that end on a phone width", async ({ page }) => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const to of [755, 700, 742]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(600);
      const widths: number[] = [];
      for (let width = 1440; width > to; ) widths.push((width = Math.max(to, width - Math.round(3 + random() * 37))));
      await drag(page, widths);
      await expectBack(page, `random drag to ${to}`);
    }
  });
});

// A classic scrollbar takes about 15 px from the page but not from the
// viewport its media queries see. The top bar leaves Cub corner room by a
// media query, so Cub must take the page's word for it, never his host's own
// width: between 1000 and 1015 px he once sat on the bell and "..." while the
// corner room stood empty. The scrollbar is emulated by narrowing the document
// by its width (headless Chromium draws overlay scrollbars).
test.describe("Cub beside a classic scrollbar", () => {
  for (const [viewport, perch] of [
    [1005, "corner"],
    [1014, "corner"],
    [995, "header"],
  ] as const) {
    test(`follows the top bar's ${perch} room at a ${viewport} px viewport`, async ({ page }) => {
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = "html { width: calc(100% - 15px) !important; }";
          document.head.append(style);
        });
      });
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
      await page.goto("/?cub-dev=0");
      await page.waitForFunction(() => document.querySelector("[data-cub-mode]"), null, { timeout: 30_000 });
      await page.waitForTimeout(300);
      const seen = await page.evaluate(() => {
        const layer = document.querySelector('[data-testid="landing-cub-layer"]') as HTMLElement;
        const strip = document.querySelector('[data-testid="landing-tab-strip"]') as HTMLElement;
        return {
          host: Math.round(layer.getBoundingClientRect().width),
          room: getComputedStyle(strip).getPropertyValue("--cub-perch").trim(),
          mode: layer.dataset.cubMode,
        };
      });
      expect(seen.host).toBe(viewport - 15);
      expect(seen.room).toBe(perch);
      expect(seen.mode).toBe(perch);
    });
  }
});

// The phone bar gives the chat's title the room the studio's toggle, bell and
// "+" took: on the narrowest phones every scenario's title reads whole.
test.describe("the landing's phone bar", () => {
  for (const width of [360, 375]) {
    test(`reads every chat title whole at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
      await page.goto("/?cub-dev=0");
      const bar = page.getByTestId("landing-phone-bar");
      await expect(bar).toBeVisible();
      const titles = () =>
        bar.evaluate((el) =>
          [...el.querySelectorAll('[data-cub-anchor="title"] span')]
            .filter((span) => span.children.length === 0)
            .map((span) => ({ text: span.textContent ?? "", whole: span.scrollWidth <= span.clientWidth })),
        );
      expect((await titles()).map((title) => title.text)).toEqual(expect.arrayContaining(["February close", "Checkout flow"]));
      // Measured once the web font has swapped in (a fallback face is wider).
      await expect
        .poll(async () => (await titles()).filter((title) => !title.whole).map((title) => title.text), { timeout: 5_000 })
        .toEqual([]);
    });
  }
});

// Cub's front arms hang to the floor anchor (TurnColumn's data-cub-anchor
// "floor"), which sits 16px under the window's top bar: where the
// conversation began before the views bar came between them. Its offset is
// the views bar's height (md:-top-[45px]), so a views bar of another height
// would silently move his arms down onto the views; this ties the two.
test.describe("Cub's floor under the window's top bar", () => {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
  ] as const) {
    test(`stays 16 px under the top bar at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
      await page.goto("/?cub-dev=0");
      await page.getByTestId("landing-session-deck").waitFor();
      const seen = await page.evaluate(() => {
        const floor = document.querySelector('[data-scenario-copy="active"] [data-cub-anchor="floor"]')!.getBoundingClientRect();
        const strip = document.querySelector('[data-testid="landing-tab-strip"]')!.getBoundingClientRect();
        const views = document.querySelector('[data-testid="landing-views-bar"]')!.getBoundingClientRect();
        return { floor: floor.top, strip: strip.bottom, views: views.top };
      });
      expect(Math.abs(seen.views - seen.strip)).toBeLessThanOrEqual(1);
      expect(Math.abs(seen.floor - seen.strip - 16)).toBeLessThanOrEqual(1);
    });
  }
});
