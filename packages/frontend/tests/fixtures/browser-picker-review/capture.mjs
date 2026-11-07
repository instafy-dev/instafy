import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const version = process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after";
const output = path.resolve(process.env.INSTAFY_REVIEW_ARTIFACT_DIR ?? "test-results/browser-picker-review-captures");
const base = process.env.INSTAFY_BROWSER_PICKER_URL ?? (version === "before" ? "http://127.0.0.1:5426" : "http://127.0.0.1:5424");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true });
const stress = process.argv.includes("--stress");
const dimensions = stress ? [
  { width: 1280, height: 900, tag: "split-360", query: "&layout=split", touch: false },
  { width: 320, height: 480, tag: "320-large", query: "&text=large", touch: true },
  { width: 844, height: 390, tag: "844-landscape", query: "", touch: true },
] : [320, 390, 1280].map(width => ({ width, height: width < 768 ? 844 : 900, tag: String(width), query: "", touch: width < 768 }));
const surfaces = process.env.INSTAFY_REVIEW_SURFACES?.split(",") ?? (stress ? ["picker", "closed", "error", "live"] : ["picker", "picker-disabled", "connecting", "closed", "error", "reconnecting", "live"]);
const records = [];
for (const theme of ["light", "dark"]) for (const { width, height, tag, query, touch } of dimensions) for (const surface of surfaces) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  await page.goto(`${base}/tests/fixtures/browser-picker-review/index.html?theme=${theme}&surface=${surface.startsWith("picker") ? "picker" : "recovery"}&state=${surface}${surface === "picker-disabled" ? "&authority=none" : ""}${query}`);
  const target = page.getByTestId(surface.startsWith("picker") ? "shared-browser-chrome" : "local-browser-share-viewer");
  await target.waitFor();
  if (["closed", "error", "reconnecting"].includes(surface)) await page.getByTestId("local-tab-reconnect").waitFor();
  if (surface === "reconnecting") { await page.getByTestId("local-tab-reconnect").click(); await page.waitForTimeout(100); }
  if (surface === "live") await page.getByTestId("local-browser-share-image").evaluate(image => new Promise(resolve => { if (image.complete) resolve(null); else image.addEventListener("load", resolve, { once: true }); }));
  await page.mouse.move(0, 0);
  const name = `${version}-${surface}-${theme}-${tag}`;
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  const box = await target.boundingBox();
  const x = Math.max(0, Math.floor(box.x - 20)); const y = Math.max(0, Math.floor(box.y - 20));
  await page.screenshot({ path: path.join(output, `${name}-detail.png`), clip: { x, y, width: Math.min(width - x, Math.ceil(box.width + 40)), height: Math.min(height - y, Math.ceil(box.height + 40)) } });
  records.push({ name, box, controls: await target.locator("button, select").evaluateAll(controls => controls.map(control => {
    const box = control.getBoundingClientRect(); const style = getComputedStyle(control);
    return { label: control.getAttribute("aria-label") ?? control.textContent?.trim(), width: box.width, height: box.height, left: box.left, right: box.right, radius: style.borderRadius, font: style.fontSize };
  })) });
  await context.close();
}
await browser.close();
await fs.writeFile(path.join(output, `${version}${stress ? "-stress" : ""}${process.env.INSTAFY_REVIEW_SURFACES ? "-targeted" : ""}-geometry.json`), JSON.stringify(records, null, 2));
console.log(`Captured ${records.length} ${version} views with full and detail screenshots`);
