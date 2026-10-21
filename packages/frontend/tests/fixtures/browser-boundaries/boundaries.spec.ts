import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const baseline = process.env.INSTAFY_BROWSER_BOUNDARIES_BEFORE === "1";
const evidence = process.env.INSTAFY_BROWSER_BOUNDARIES_EVIDENCE_DIR;

for (const width of [320, 390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`${theme} utility controls at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(baseline, "Current utility styling is checked only against the updated source.");
      const context = await browser.newContext({ viewport: { width, height: 1100 }, hasTouch: width < 540 });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        const remoteRequests: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => {
          const url = new URL(route.request().url());
          if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
            remoteRequests.push(url.origin);
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(`${testInfo.project.use.baseURL}/tests/fixtures/browser-boundaries/index.html?theme=${theme}`);
        const controls = page.getByRole("region", { name: "Shared browser toolbar controls", exact: true });
        const back = controls.getByRole("button", { name: "Back", exact: true });
        const forward = controls.getByRole("button", { name: "Forward", exact: true });
        const reload = controls.getByRole("button", { name: "Reload", exact: true });
        const dismiss = controls.getByRole("button", { name: "Dismiss browser message", exact: true });
        for (const button of [back, forward, reload, dismiss]) {
          await expect(button).toHaveCSS("border-radius", "8px");
          const bounds = (await button.boundingBox())!;
          if (width < 540) {
            expect(bounds.width).toBeGreaterThanOrEqual(44);
            expect(bounds.height).toBeGreaterThanOrEqual(44);
          }
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        for (const [previous, next] of [[back, forward], [forward, reload]]) {
          const first = (await previous.boundingBox())!;
          const second = (await next.boundingBox())!;
          expect(second.x - first.x - first.width, "navigation controls leave room for their focus rings").toBeCloseTo(8);
        }
        await reload.focus();
        await reload.press("Enter");
        await expect(reload).toBeFocused();
        for (const button of [reload, controls.getByRole("button", { name: "Show example message", exact: true })]) {
          const focusClearance = await button.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            const toolbar = element.closest('[role="toolbar"]')!;
            const toolbarBounds = toolbar.getBoundingClientRect();
            const clippingAncestors: string[] = [];
            let parent = element.parentElement;
            while (parent && parent !== toolbar) {
              if (["hidden", "clip"].includes(getComputedStyle(parent).overflowY)) clippingAncestors.push(parent.className);
              parent = parent.parentElement;
            }
            return { top: bounds.top - toolbarBounds.top, bottom: toolbarBounds.bottom - bounds.bottom, clippingAncestors };
          });
          expect(focusClearance.top, "the toolbar leaves room above the keyboard focus ring").toBeGreaterThanOrEqual(4);
          expect(focusClearance.bottom, "the toolbar leaves room below the keyboard focus ring").toBeGreaterThanOrEqual(4);
          expect(focusClearance.clippingAncestors).toEqual([]);
        }
        await dismiss.click();
        await expect(controls.getByRole("alert")).toHaveCount(0);
        const resume = controls.getByRole("button", { name: "Resume agent control", exact: true });
        await expect(resume).toHaveCSS("border-radius", "8px");
        await resume.click();
        await expect(resume).toHaveCount(0);
        await expect(controls.getByRole("status", { name: "Ready", exact: true })).toHaveCount(1);

        const session = page.getByRole("region", { name: "Conversation and browser boundary", exact: true });
        const options = session.getByRole("button", { name: "Browser options", exact: true });
        await expect(options).toHaveCSS("border-radius", "8px");
        await options.focus();
        await options.press("Enter");
        const popup = page.getByRole("dialog", { name: "Browser options", exact: true });
        await expect(popup).toBeVisible();
        const popupBounds = (await popup.boundingBox())!;
        expect(popupBounds.x).toBeGreaterThanOrEqual(0);
        expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(width);
        for (const button of await popup.getByRole("button").all()) {
          await expect(button).toHaveCSS("border-radius", "8px");
          if (width < 540) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        await popup.press("Escape");
        await expect(options).toBeFocused();
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(width < 540);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        expect(remoteRequests).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

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
      await expect(page.getByTestId("shared-browser-chrome").first()).toBeVisible();
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
