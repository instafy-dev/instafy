import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
const preloadSource = readFileSync(path.join(__dirname, "..", "src", "preload.ts"), "utf8");

// Geometry the frontend's integrated title bar depends on. These live in two
// packages that ship on different schedules, so the numbers are asserted here
// rather than trusted to stay in sync by inspection.
const TRAFFIC_LIGHTS_END_X = 65; // three 12px dots on a 20px pitch from x=13
const RAIL_WIDTH_PX = 64; // w-[4rem] in StudioSidebar
const FIRST_TAB_OFFSET_PX = 24; // DESKTOP_TITLE_BAR_TAB_OFFSET_PX

function constant(name) {
  const match = mainSource.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `expected ${name} to be declared in main.ts`);
  return Number(match[1]);
}

test("the drag region is a corner, never a full-width bar", () => {
  // A full-width strip at maximum z-index makes the entire top row unusable
  // for anything interactive: a tab raised into it receives a window drag
  // instead of a click. The strip must therefore be bounded horizontally.
  const block = mainSource.slice(
    mainSource.indexOf("#instafy-mac-drag-region {"),
    mainSource.indexOf("#instafy-mac-drag-region *"),
  );
  assert.ok(block.includes("width:"), "drag region must set an explicit width");
  assert.ok(!/right:\s*0/.test(block), "drag region must not stretch to the right edge");
});

test("the drag corner covers the window buttons and stops short of the first tab", () => {
  const width = constant("MAC_WINDOW_CHROME_DRAG_CORNER_WIDTH_PX");
  assert.ok(
    width > TRAFFIC_LIGHTS_END_X,
    `drag corner (${width}) must cover the traffic lights, which end at ${TRAFFIC_LIGHTS_END_X}`,
  );
  const firstTabX = RAIL_WIDTH_PX + FIRST_TAB_OFFSET_PX;
  assert.ok(
    width <= firstTabX,
    `drag corner (${width}) must stop short of the first tab at x=${firstTabX}, or tab clicks drag the window`,
  );
});

test("the shell advertises the integrated title bar to the frontend", () => {
  // The frontend ships over the web and reaches installed apps immediately,
  // so it must be able to tell a shell that narrowed its drag region from one
  // that did not. Only darwin has traffic lights to work around.
  assert.match(preloadSource, /titleBarFree:\s*process\.platform === "darwin"/);
});
