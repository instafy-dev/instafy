import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const output = path.resolve(process.env.INSTAFY_REVIEW_ARTIFACT_DIR ?? "test-results/chat-references-review");
const version = process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after";
const base = process.env.INSTAFY_CHAT_REFERENCES_URL ?? (version === "before" ? "http://127.0.0.1:5422" : "http://127.0.0.1:5420");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true });
const records = [];
const stress = process.argv.includes("--stress");
const scenarios = stress ? [
  { width: 320, height: 360, touch: true, tag: "320-short", query: "" },
  { width: 844, height: 390, touch: true, tag: "844-landscape", query: "" },
  { width: 320, height: 640, touch: true, tag: "320-large", query: "&text=large" },
] : [320, 390, 1280].map(width => ({ width, height: width === 320 ? 740 : width === 390 ? 844 : 900, touch: width < 768, tag: String(width), query: "" }));
for (const theme of ["light", "dark"]) for (const { width, height, touch, tag, query } of scenarios) for (const surface of (stress ? ["preview", "error"] : ["quote", "preview", "loading", "error"])) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  await page.goto(`${base}/tests/fixtures/chat-references/index.html?theme=${theme}&state=${surface}${query}`);
  const message = page.getByTestId("review-message");
  await message.waitFor();
  let target = message;
  if (surface !== "quote") {
    const chip = page.getByTestId("chat-message-file-reference-inline");
    if (!touch) { await chip.focus(); await chip.press("Shift+F10"); await page.getByRole("menuitem", { name: "Preview", exact: true }).click(); }
    else {
      const box = await chip.boundingBox();
      const session = await context.newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(650);
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
    }
    target = page.getByTestId("chat-message-file-reference-preview");
    await target.waitFor();
    if (surface === "preview") await target.getByText(/return <History/).waitFor();
    if (surface === "error") await page.waitForTimeout(400);
  }
  const name = `${version}-${surface}-${theme}-${tag}`;
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  const box = await target.boundingBox();
  const x = Math.max(0, Math.floor(box.x - 20)); const y = Math.max(0, Math.floor(box.y - 20));
  await page.screenshot({ path: path.join(output, `${name}-detail.png`), clip: { x, y, width: Math.min(width - x, Math.ceil(box.width + 40)), height: Math.min(height - y, Math.ceil(box.height + 40)) } });
  records.push({ name, box, bodyWidth: await page.evaluate(() => document.documentElement.scrollWidth), quote: await page.getByTestId("chat-message-quote-source-reference").boundingBox() });
  await context.close();
}
await browser.close();
await fs.writeFile(path.join(output, `${version}${stress ? "-stress" : ""}-geometry.json`), JSON.stringify(records, null, 2));
console.log(`Captured ${records.length} ${version} views with full and detail screenshots`);
