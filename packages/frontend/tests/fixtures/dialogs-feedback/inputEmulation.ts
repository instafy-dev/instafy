import { expect, type Page } from "@playwright/test";

/** Verify the browser capability itself before testing pointer-dependent CSS. */
export async function expectPointerCapability(page: Page, hasTouch: boolean) {
  await expect.poll(() => page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    fine: matchMedia("(pointer: fine)").matches,
    touch: navigator.maxTouchPoints > 0,
  })), {
    message: `The browser context must expose ${hasTouch ? "coarse touch" : "fine mouse"} input before UI checks`,
  }).toEqual({ coarse: hasTouch, fine: !hasTouch, touch: hasTouch });
}
