import { expect, test, type Locator } from "@playwright/test";

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "touch control surfaces" : "mouse control surfaces", () => {
    test.use({ hasTouch });
    for (const width of [390, 1280]) {
      for (const mode of ["Light", "Dark"]) {
        test(`shared appearances and targets at ${width}px in ${mode.toLowerCase()} mode`, async ({ page }, testInfo) => {
          const activate = (control: Locator) => hasTouch ? control.tap() : control.click();
          await page.setViewportSize({ width, height: 900 });
          await page.goto("/tests/fixtures/control-surfaces/index.html");
          await expect(page.getByRole("heading", { name: "Control surface review" })).toBeVisible();
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(hasTouch);
          const theme = page.getByRole("radiogroup", { name: "Theme", exact: true });
          const search = page.getByTestId("files-explorer-search-toggle");
          await activate(theme.getByText(mode, { exact: true }));
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "pointer after choosing theme").toBe(hasTouch);
          await expect(page.locator("html")).toHaveAttribute("style", /color-scheme/);
          for (const id of ["review-save", "review-cancel"]) {
            const bounds = (await page.getByTestId(id).boundingBox())!;
            expect(bounds.height, id).toBe(hasTouch ? 44 : 36);
          }
          const segment = page.getByTestId(`profile-preference-theme-${mode.toLowerCase()}`);
          expect((await segment.boundingBox())!.height).toBe(hasTouch ? 44 : 36);
          expect((await search.boundingBox())!.height).toBe(hasTouch ? 44 : 32);

          await activate(search);
          await expect(search).toHaveAttribute("aria-expanded", "true");
          const input = page.getByTestId("code-search-input");
          await expect(input).toBeFocused();
          await input.fill("components/Button");
          await input.press("Escape");
          await expect(input).toHaveCount(0);
          await expect(search).toBeFocused();

          // Machine titles lead; secondary information stays at one size and
          // shares the title's left edge rather than gaining nested indents.
          for (const regionName of ["Runtime list actions", "Runtime header actions"]) {
            const region = page.getByRole("region", { name: regionName, exact: true });
            const title = region.getByText("Review machine", { exact: true });
            const description = region.getByText("A stopped self-hosted machine used only for the local component review.", { exact: true });
            const label = region.getByText("Image", { exact: true });
            const value = region.getByText("example/runtime:review", { exact: true });
            await expect(title).toHaveCSS("font-size", "14px");
            await expect(title).toHaveCSS("font-weight", "500");
            expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth), "short machine names fit beside controls").toBe(true);
            for (const supporting of [description, label, value, region.locator('[title="review-runtime"]')]) {
              await expect(supporting).toHaveCSS("font-size", "12px");
              await expect(supporting).toHaveCSS("font-weight", "400");
            }
            await expect(label).toHaveCSS("text-align", "start");
            const titleLeft = (await title.boundingBox())!.x;
            for (const aligned of [description, label]) {
              expect(Math.abs((await aligned.boundingBox())!.x - titleLeft)).toBeLessThanOrEqual(1);
            }
          }

          const machineList = page.getByRole("region", { name: "Runtime list actions", exact: true });
          const reviewMachine = machineList.getByRole("button", { name: /^Review machine/ });
          const runningMachine = machineList.getByRole("button", { name: /^Running machine/ });
          await expect(reviewMachine).toHaveAttribute("aria-pressed", "true");
          await expect(reviewMachine.locator('[title="Selected"]')).toBeVisible();
          await activate(runningMachine);
          await expect(reviewMachine).toHaveAttribute("aria-pressed", "false");
          await expect(reviewMachine.locator('[title="Selected"]')).toHaveCount(0);
          await expect(runningMachine).toHaveAttribute("aria-pressed", "true");
          await expect(runningMachine.locator('[title="Selected"]')).toBeVisible();
          await activate(machineList.getByRole("button", { name: "Use best available" }));
          await expect(machineList.locator('[aria-pressed="true"]')).toHaveCount(0);
          await activate(reviewMachine);

          const machineHeader = page.getByRole("region", { name: "Runtime header actions", exact: true });
          const neutralColor = await page.getByTestId("review-cancel").evaluate(el => getComputedStyle(el).color);
          for (const control of [
            machineList.getByRole("button", { name: "Start", exact: true }),
            machineHeader.getByRole("button", { name: "Start Review machine", exact: true }),
            machineHeader.getByRole("button", { name: "Stop Running machine", exact: true }),
          ]) {
            await expect(control).toHaveCSS("color", neutralColor);
          }

          const details = page.getByRole("button", { name: "View details", exact: true });
          const stop = page.getByRole("button", { name: "Stop blocker and retry", exact: true });
          const a = (await details.boundingBox())!;
          const b = (await stop.boundingBox())!;
          expect(b.x >= a.x + a.width + 11 || b.y >= a.y + a.height + 3).toBe(true);
          if (hasTouch) {
            expect(a.height).toBeGreaterThanOrEqual(44);
            expect(b.height).toBeGreaterThanOrEqual(44);
          }
          await activate(details);
          await expect(page.getByRole("region", { name: "Runtime recovery actions" }).locator("pre")).toBeVisible();
          await activate(page.getByRole("button", { name: "Hide details", exact: true }));
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await activate(page.getByTestId("review-save"));
          await expect(page.getByRole("status")).toHaveText("Preview saves: 1");
          await activate(page.getByTestId("review-cancel"));
          await expect(page.getByRole("status")).toHaveText("Preview saves: 0");
          // A full-page capture on a tall document currently clears Chromium's
          // touch emulation. Capture the actual viewport at both ends instead,
          // preserving pointer state for this case and subsequent contexts.
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: testInfo.outputPath(`${mode.toLowerCase()}-top.png`) });
          await page.getByRole("region", { name: "Runtime recovery actions" }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`${mode.toLowerCase()}-recovery.png`) });
          await activate(stop);
          const failure = page.getByTestId("runtime-action-error");
          await expect(failure).toHaveAttribute("role", "alert");
          await expect(failure).toContainText("Runtime takeover did not complete.");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await failure.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`${mode.toLowerCase()}-recovery-failure.png`) });
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(hasTouch);
        });
      }
    }
  });
}
