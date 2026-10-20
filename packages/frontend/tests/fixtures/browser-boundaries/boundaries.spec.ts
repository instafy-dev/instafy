import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const baseline = process.env.INSTAFY_BROWSER_BOUNDARIES_BEFORE === "1";
const evidence = process.env.INSTAFY_BROWSER_BOUNDARIES_EVIDENCE_DIR;

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`${theme} boundaries at ${width}px`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 540 });
      const page = await context.newPage();
      const errors: string[] = [];
      const remoteRequests: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
          remoteRequests.push(url.origin);
          return route.abort();
        }
        await route.continue();
      });
      await page.goto(`${testInfo.project.use.baseURL}/tests/fixtures/browser-boundaries/index.html?theme=${theme}`);
      await expect(page.getByTestId("shared-browser-chrome")).toBeVisible();
      await expect(page.getByRole("heading", { name: `Browser boundaries · ${baseline ? "Before" : "After"}` })).toBeVisible();
      const headerTabs = page.getByTestId("conversation-subtabs").first();
      const modal = page.getByTestId("browser-session-modal");
      expect(await headerTabs.evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe("1px");
      expect(await modal.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe(baseline ? "1px" : "0px");
      const toolbar = page.getByTestId("review-wrapped-chrome");
      expect(await toolbar.evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe("1px");
      expect(await toolbar.getByTestId("browser-chrome-context-row").evaluate(element => getComputedStyle(element).borderTopWidth))
        .toBe(baseline && width < 540 ? "1px" : "0px");
      const composer = page.getByRole("region", { name: "Composer view switcher" });
      const chat = composer.getByRole("tab", { name: "Chat", exact: true });
      const browserTab = composer.getByRole("tab", { name: "Browser", exact: true });
      const shadow = await chat.evaluate(element => getComputedStyle(element.parentElement!).boxShadow);
      if (baseline) expect(shadow).not.toBe("none");
      else expect(shadow).toBe("none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width < 540) {
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        for (const control of [chat, browserTab, toolbar.getByRole("button", { name: "Reload", exact: true })]) {
          expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
      }
      await page.mouse.move(width - 2, 1);
      const name = `browser-${baseline ? "before" : "after"}-${theme}-${width}.png`;
      if (evidence) await mkdir(evidence, { recursive: true });
      const screenshot = evidence ? path.join(evidence, name) : testInfo.outputPath(name);
      await page.screenshot({ path: screenshot, animations: "disabled", fullPage: true });
      await testInfo.attach("Production browser boundaries", { path: screenshot, contentType: "image/png" });

      await chat.focus();
      await chat.press("ArrowRight");
      await expect(browserTab).toBeFocused();
      await expect(browserTab).toHaveAttribute("aria-selected", "true");
      await expect(chat).toHaveAttribute("aria-selected", "false");
      await page.emulateMedia({ forcedColors: "active" });
      expect(await browserTab.evaluate(element => getComputedStyle(element).outlineStyle)).toBe(baseline ? "none" : "solid");
      await page.getByRole("heading", { level: 1 }).click();
      expect(await browserTab.evaluate(element => getComputedStyle(element).outlineStyle)).toBe(baseline ? "none" : "solid");
      expect(errors).toEqual([]);
      expect(remoteRequests).toEqual([]);
      await context.close();
    });
  }
}
