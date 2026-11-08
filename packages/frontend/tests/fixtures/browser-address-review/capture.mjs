import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const version = process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after";
const output = path.resolve(process.env.INSTAFY_REVIEW_ARTIFACT_DIR ?? "test-results/browser-address-review-captures");
const base = process.env.INSTAFY_BROWSER_ADDRESS_URL ?? (version === "before" ? "http://127.0.0.1:5429" : "http://127.0.0.1:5427");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true });
const stress = process.argv.includes("--stress");
const dimensions = stress ? [
  { width: 1280, height: 900, tag: "split-360", query: "&layout=split", touch: false },
  { width: 320, height: 480, tag: "320-large", query: "&text=large", touch: true },
  { width: 844, height: 390, tag: "844-landscape", query: "", touch: true, rotate: true },
  { width: 390, height: 300, tag: "390-keyboard", query: "", touch: true },
  { width: 600, height: 720, tag: "600-large", query: "&text=large", touch: false },
] : [320, 390, 1280].map(width => ({ width, height: width < 768 ? 844 : 900, tag: String(width), query: "", touch: width < 768 }));
const surfaces = process.env.INSTAFY_REVIEW_SURFACES?.split(",") ?? ["closed", "recent", "filtered", "invalid", "empty"];
const records = [];
for (const theme of ["light", "dark"]) for (const { width, height, tag, query, touch, rotate } of dimensions) for (const surface of surfaces) {
  if (tag === "600-large" && surface !== "closed") continue;
  const context = await browser.newContext({ viewport: rotate ? { width: 390, height: 844 } : { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  await page.goto(`${base}/tests/fixtures/browser-address-review/index.html?theme=${theme}${query}`);
  const trigger = page.getByTestId("shared-browser-address-trigger");
  const input = page.getByTestId("shared-browser-address");
  if (surface !== "closed") {
    if (await trigger.count()) await trigger.click();
    await input.waitFor(); await input.fill("");
    await page.getByRole("listbox", { name: "Recent sites" }).waitFor();
  }
  if (rotate) await page.setViewportSize({ width, height });
  if (surface === "filtered") await input.fill("design");
  if (surface === "invalid") { await input.fill("file:///private/notes.txt"); await input.press("Enter"); await page.getByRole("alert").first().waitFor(); }
  if (surface === "empty") await page.getByRole("button", { name: "Clear recent sites", exact: true }).click();
  await page.mouse.move(0, 0); await page.waitForTimeout(180);
  const name = `${version}-${surface}-${theme}-${tag}`;
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  const editor = page.getByTestId("shared-browser-address-editor");
  let target = page.getByTestId("shared-browser-chrome");
  if (await editor.count()) target = editor;
  let box = await target.boundingBox();
  const menu = page.getByRole("listbox", { name: "Recent sites" });
  if (!(await editor.count()) && await menu.count()) {
    const menuBox = await menu.boundingBox();
    if (menuBox) box = { ...box, x: Math.min(box.x, menuBox.x), width: Math.max(box.width, menuBox.width), height: Math.max(box.height, menuBox.y + menuBox.height + 48 - box.y) };
  } else if (!(await editor.count()) && surface === "invalid") box.height += 70;
  const x = Math.max(0, Math.floor(box.x - 16)); const y = Math.max(0, Math.floor(box.y - 16));
  await page.screenshot({ path: path.join(output, `${name}-detail.png`), clip: { x, y, width: Math.min(width - x, Math.ceil(box.width + 32)), height: Math.min(height - y, Math.ceil(box.height + 32)) } });
  records.push({ name, box, input: await (await input.count() ? input : trigger).evaluate(element => { const b=element.getBoundingClientRect(); const s=getComputedStyle(element); return { width:b.width, height:b.height, font:s.fontSize, radius:s.borderRadius }; }) });
  await context.close();
}
await browser.close();
await fs.writeFile(path.join(output, `${version}${stress ? "-stress" : ""}${process.env.INSTAFY_REVIEW_SURFACES ? "-targeted" : ""}-geometry.json`), JSON.stringify(records, null, 2));
console.log(`Captured ${records.length} ${version} views with full and detail screenshots`);
