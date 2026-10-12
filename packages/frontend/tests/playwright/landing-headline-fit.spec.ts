import { expect, test, type Page } from "@playwright/test";

// The landing headline is set in rem, so a visitor's larger default text size
// (a browser font-size setting or Android text scaling) grows it. Its lines
// must then wrap rather than run past the hero, which clips (overflow-hidden),
// or under the open cell beside the copy from md up. 24px is Chrome's "Very
// large" default font size, 150% of the usual 16px.

type Fit = { lines: { text: string; right: number }[]; headingRight: number; heroRight: number; scrollWidth: number; innerWidth: number };

async function measure(page: Page, rootPx: number): Promise<Fit> {
  return page.evaluate(async (px) => {
    document.documentElement.style.fontSize = `${px}px`;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const heading = document.querySelector<HTMLElement>('[data-testid="landing-hero-heading"]')!;
    const hero = document.querySelector<HTMLElement>('[data-testid="landing-hero"]')!;
    const lines = [...heading.querySelectorAll("span")].map((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      const rights = [...range.getClientRects()].map((rect) => rect.right);
      return { text: span.textContent ?? "", right: Math.max(...rights) };
    });
    return {
      lines,
      headingRight: heading.getBoundingClientRect().right,
      heroRight: hero.getBoundingClientRect().right,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, rootPx);
}

for (const width of [320, 375, 768, 1024, 1280]) {
  test(`the landing headline fits its column at ${width}px with default and larger text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.goto("/?cub-dev=0");
    await page.getByTestId("landing-hero-heading").waitFor();
    await page.waitForFunction(() => document.fonts.status === "loaded");

    for (const rootPx of [16, 24]) {
      const fit = await measure(page, rootPx);
      const label = `${width}px, ${rootPx}px root`;
      expect(fit.headingRight, `${label}: the heading stays inside the hero`).toBeLessThanOrEqual(fit.heroRight + 0.5);
      for (const line of fit.lines) {
        expect(line.right, `${label}: "${line.text}" stays inside the heading`).toBeLessThanOrEqual(fit.headingRight + 0.5);
      }
      expect(fit.scrollWidth, `${label}: no horizontal page scroll`).toBeLessThanOrEqual(fit.innerWidth);
    }
  });
}
