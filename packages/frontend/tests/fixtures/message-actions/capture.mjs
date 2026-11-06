import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const output = path.resolve(process.env.INSTAFY_REVIEW_ARTIFACT_DIR ?? "test-results/message-actions-review");
const version = process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after";
const base = process.env.INSTAFY_MESSAGE_ACTIONS_URL ?? (version === "before" ? "http://127.0.0.1:5413" : "http://127.0.0.1:5412");
const stress = process.argv.includes("--stress");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_UI_CHANNEL ?? "chrome", headless: true });
const records = [];
const scenarios = stress ? [
  { width: 320, height: 280, touch: true, surface: "stats", tag: "320-short", query: "&anchor=edge" },
  { width: 320, height: 420, touch: true, surface: "stats", tag: "320-large", query: "&text=large&anchor=edge" },
  { width: 320, height: 420, touch: true, surface: "invite", tag: "320-large", query: "&text=large&names=long" },
  { width: 320, height: 420, touch: true, surface: "invite", tag: "320-large-scrolled", query: "&text=large&names=long", scroll: true },
  { width: 844, height: 390, touch: true, surface: "stats", tag: "844-landscape", query: "" },
  { width: 844, height: 390, touch: true, surface: "invite", tag: "844-landscape", query: "&names=long" },
] : [320, 390, 1280].flatMap(width => ["actions", "stats", "invite", "invite-busy"].map(surface => ({
  width, height: width === 320 ? 740 : width === 390 ? 844 : 900, touch: width < 768, surface, tag: String(width), query: "",
})));
for (const theme of ["light", "dark"]) for (const { width, height, touch, surface, tag, query, scroll } of scenarios) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  await page.goto(`${base}/tests/fixtures/message-actions/index.html?theme=${theme}&surface=${surface}${query}`);
  await page.getByTestId("review-open").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  if (scroll) await dialog.getByText(/These teammates can’t see this conversation yet:/).evaluate(node => {
    let container = node.parentElement;
    while (container && !["auto", "scroll"].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  });
  await page.mouse.move(0, 0);
  const name = `${version}-${surface}-${theme}-${tag}`;
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  // The legacy invite role covered its backdrop; crop the visible panel in both versions.
  const visibleSurface = version === "before" && surface.startsWith("invite") ? dialog.locator(":scope > div").first() : dialog;
  const box = await visibleSurface.boundingBox();
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  await page.screenshot({ path: path.join(output, `${name}-detail.png`), clip: {
    x, y, width: Math.min(viewport.width - x, Math.ceil(box.width + 48)), height: Math.min(viewport.height - y, Math.ceil(box.height + 48)),
  } });
  records.push({ name, viewport, dialog: box, buttons: await dialog.locator("button").evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return { label: button.getAttribute("aria-label") ?? button.textContent.trim(), x: box.x, y: box.y, width: box.width, height: box.height, radius: style.borderRadius, font: style.fontSize };
  })) });
  await context.close();
}
await browser.close();
await fs.writeFile(path.join(output, `${version}${stress ? "-stress" : ""}-geometry.json`), JSON.stringify(records, null, 2));
console.log(`Captured ${records.length} ${version} views with full and detail screenshots`);
