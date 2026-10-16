import { expect, test, type Locator } from "@playwright/test";

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "touch control surfaces" : "mouse control surfaces", () => {
    test.use({ hasTouch });
    for (const width of [390, 1280, 2560]) {
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

          const primaryColor = await page.getByRole("heading", { name: "Control surface review" }).evaluate(el => getComputedStyle(el).color);
          // Button theme colors transition; compare their settled token color,
          // rather than capturing an intermediate interpolated value.
          await page.getByTestId("review-cancel").evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
          const secondaryColor = await page.getByTestId("review-cancel").evaluate(el => getComputedStyle(el).color);
          const shell = page.getByTestId("review-machines-shell");
          const shellBox = (await shell.boundingBox())!;
          expect(shellBox.width).toBeLessThanOrEqual(896);
          if (width >= 1280) expect(shellBox.width).toBe(896);
          expect(Math.abs(shellBox.x + shellBox.width / 2 - width / 2)).toBeLessThanOrEqual(1);

          // Reading text uses body size/contrast; technical metadata stays
          // compact. Both align with the machine name and remain stable on ultrawide screens.
          for (const regionName of ["Runtime list actions", "Runtime header actions"]) {
            const region = page.getByRole("region", { name: regionName, exact: true });
            const title = region.getByText("Review machine", { exact: true });
            const description = region.getByText("A stopped self-hosted machine used only for the local component review.", { exact: true });
            const label = region.getByText("Image", { exact: true });
            const value = region.getByText("example/runtime:review", { exact: true });
            await expect(title).toHaveCSS("font-size", "14px");
            await expect(title).toHaveCSS("font-weight", "500");
            expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth), "short machine names fit beside controls").toBe(true);
            await expect(title).toHaveCSS("color", primaryColor);
            await expect(description).toHaveCSS("font-size", "14px");
            await expect(description).toHaveCSS("font-weight", "400");
            await expect(description).toHaveCSS("color", secondaryColor);
            await expect(region.locator('[title="review-runtime"]')).toHaveCSS("color", secondaryColor);
            const metadataColor = await label.evaluate(el => getComputedStyle(el).color);
            expect(metadataColor).not.toBe(secondaryColor);
            await expect(value).toHaveCSS("color", metadataColor);
            for (const supporting of [label, value, region.locator('[title="review-runtime"]')]) {
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
          const managedMachine = machineHeader.getByRole("button", { name: /^Review machine/ });
          await expect(managedMachine).toHaveAttribute("aria-expanded", "true");
          await activate(managedMachine);
          await expect(managedMachine).toHaveAttribute("aria-expanded", "false");
          await expect(machineHeader.getByText("Pinned to Review machine")).toHaveCount(0);
          await activate(managedMachine);
          const selectMachine = machineHeader.getByRole("button", { name: "Use this machine", exact: true });
          await expect(selectMachine).toHaveCSS("font-size", "14px");
          await expect(selectMachine).toHaveCSS("box-shadow", "none");
          expect(await selectMachine.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
          if (!hasTouch) {
            await selectMachine.hover();
            await expect(selectMachine).toHaveCSS("box-shadow", "none");
          }
          await activate(selectMachine);
          await expect(selectMachine).toHaveCount(0);
          await expect(machineHeader.getByRole("button", { name: "Selected machine", exact: true })).toHaveCount(0);
          await expect(machineHeader.getByText("Selected machine", { exact: true })).toBeVisible();
          await expect(managedMachine).toBeFocused();
          await expect(machineHeader.getByText("Pinned to Review machine")).toBeVisible();
          await expect(managedMachine.locator('[title="Selected"]')).toBeVisible();
          await expect(managedMachine).not.toHaveAttribute("aria-pressed");
          const moreActions = machineHeader.getByRole("button", { name: "More actions for Review machine", exact: true });
          await activate(moreActions);
          await activate(page.getByRole("menuitem", { name: "Remove machine…", exact: true }));
          const cancelRemoval = machineHeader.getByRole("button", { name: "Cancel", exact: true });
          await expect(cancelRemoval).toBeVisible();
          if (!hasTouch) await expect(cancelRemoval).toBeFocused();
          await activate(cancelRemoval);
          await expect(moreActions).toBeFocused();
          await expect(machineHeader.getByText('Remove “Review machine”?')).toHaveCount(0);
          await expect(managedMachine).toHaveAttribute("aria-expanded", "true");

          // Selection owns the full row, including the separate disclosure.
          const selectedSurface = reviewMachine.locator("..");
          const disclosure = selectedSurface.getByRole("button", { name: "Hide runtime details", exact: true });
          const surfaceBounds = (await selectedSurface.boundingBox())!;
          const disclosureBounds = (await disclosure.boundingBox())!;
          expect(disclosureBounds.x + disclosureBounds.width).toBeLessThanOrEqual(surfaceBounds.x + surfaceBounds.width);
          expect(await selectedSurface.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
          if (hasTouch) {
            expect((await reviewMachine.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            expect(disclosureBounds.height).toBeGreaterThanOrEqual(44);
          }
          const neutralColor = await page.getByTestId("review-cancel").evaluate(el => getComputedStyle(el).color);
          for (const control of [
            machineList.getByRole("button", { name: "Start", exact: true }),
            machineHeader.getByRole("button", { name: "Start Review machine", exact: true }),
            machineHeader.getByRole("button", { name: "Stop Running machine", exact: true }),
          ]) {
            await expect(control).toHaveCSS("color", neutralColor);
          }
          const close = machineList.getByRole("button", { name: "Close runtimes menu", exact: true });
          const copy = machineHeader.getByRole("button", { name: "Copy runtime image", exact: true });
          const iconControls = [close, copy, moreActions, disclosure,
            machineHeader.getByRole("button", { name: "Start Review machine", exact: true }),
            machineHeader.getByRole("button", { name: "Stop Running machine", exact: true })];
          const radius = await close.evaluate(el => getComputedStyle(el).borderRadius);
          for (const control of iconControls) {
            const bounds = (await control.boundingBox())!;
            expect(bounds.width).toBe(hasTouch ? 44 : 32);
            expect(bounds.height).toBe(hasTouch ? 44 : 32);
            await expect(control).toHaveCSS("border-radius", radius);
          }
          if (!hasTouch) {
            await close.focus();
            await page.keyboard.press("Tab");
            await page.keyboard.press("Shift+Tab");
            await expect(close).toBeFocused();
            await expect(close).toHaveCSS("box-shadow", /0px 0px 0px 4px/);
            const focusRing = await close.evaluate(el => getComputedStyle(el).boxShadow);
            expect(focusRing).not.toBe("none");
            await copy.focus();
            await expect(copy).toHaveCSS("box-shadow", focusRing);
            await copy.press("Tab");
            await expect(machineHeader.getByRole("button", { name: /^Running machine/ })).toBeFocused();
          }
          await machineHeader.scrollIntoViewIfNeeded();
          if (!hasTouch) await expect(copy).toHaveCSS("box-shadow", "none");
          await page.screenshot({ path: testInfo.outputPath(`${mode.toLowerCase()}-machine-rows.png`) });

          const details = page.getByRole("button", { name: "View details", exact: true });
          const stop = page.getByRole("button", { name: "Stop blocker and retry", exact: true });
          for (const action of [details, stop, machineList.getByRole("button", { name: "Start", exact: true }), machineList.getByRole("button", { name: "Use best available", exact: true })]) {
            await expect(action).toHaveCSS("font-size", "14px");
          }
          await expect(details).toHaveCSS("color", secondaryColor);
          const recovery = page.getByRole("region", { name: "Runtime recovery actions", exact: true });
          await expect(recovery.getByText("Instafy Cloud runtime limit reached", { exact: true })).toHaveCSS("color", primaryColor);
          const warningCopy = recovery.getByText("Stop a stale runtime or retry after cleanup.", { exact: false });
          await expect(warningCopy).toHaveCSS("font-size", "14px");
          await expect(warningCopy).toHaveCSS("color", secondaryColor);
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
