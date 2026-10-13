// The social card's script, bundled by scripts/generate-og-image.mjs (Vite,
// production mode) into card.js. It draws the real Octo mark from its canonical
// geometry, lays the card out, and mounts the shipping Cub engine with the
// landing's own theme, perch tuning and timeline for one deterministic frame.
// Query parameters override the layout numbers below for review renders only.

import octoMarkGeometry from "@frontend-src/assets/octo-mark.geometry.json";
import { createCub } from "@frontend-src/screens/landing/cub/cubEngine";
import { LANDING_CUB_LAYOUT, LANDING_CUB_THEME } from "@frontend-src/screens/landing/cub/landingCub";
import { LANDING_CUB_TIMELINE } from "@frontend-src/screens/landing/cub/landingCubTimeline";
import { CREW_SLOTS } from "@frontend-src/screens/landing/landingCrew";

/** The committed layout. Every number is CSS px at 1200x630 unless noted. */
const LAYOUT = {
  /** Left gutter: the headline's first glyph starts its ink here. */
  gx: 64,
  /** Where the hero's dot grid starts under the flat header band. */
  gridTop: 148,
  /** The window's top edge: the ledge Cub sits on. */
  ledge: 494,
  /** The window's right end: Cub's corner. */
  winR: 1088,
  /** The roster's right end lies this many perch units left of the corner. */
  rosterK: 2.75,
  /** Cub's perch size (the landing clamps it between 48 and 84 px; a card can afford more). */
  u: 112,
  /** Cub's pen width. */
  lineWidth: 2.9,
  /** Cub's sim time (s): an idle frame with both front arms on the ledge, eyes open. */
  t: 9,
};

const query = new URLSearchParams(location.search);
const num = (key) => (query.has(key) ? Number(query.get(key)) : LAYOUT[key]);
const P = Object.fromEntries(Object.keys(LAYOUT).map((key) => [key, num(key)]));

const SVG_NS = "http://www.w3.org/2000/svg";

/** The Octo mark at rest, as OctoMark.tsx draws it: nodes ranked by cx into crew slots. */
function drawMark(svg, crew) {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("fill", "currentColor");
  group.setAttribute("transform", octoMarkGeometry.transform);
  for (const d of octoMarkGeometry.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    group.appendChild(path);
  }
  const rank = octoMarkGeometry.circles
    .map((circle, index) => ({ cx: circle.cx, index }))
    .sort((a, b) => a.cx - b.cx)
    .reduce((slots, entry, slot) => ((slots[entry.index] = slot), slots), []);
  octoMarkGeometry.circles.forEach((circle, index) => {
    const node = document.createElementNS(SVG_NS, "circle");
    node.setAttribute("cx", String(circle.cx));
    node.setAttribute("cy", String(circle.cy));
    node.setAttribute("r", String(circle.r));
    if (crew) node.setAttribute("fill", CREW_SLOTS[rank[index]].fill);
    group.appendChild(node);
  });
  svg.appendChild(group);
}

/** Distance from an element's left edge to the ink of its first glyph. */
function leadingBearing(element, text) {
  const style = getComputedStyle(element);
  const context = document.createElement("canvas").getContext("2d");
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  context.letterSpacing = style.letterSpacing;
  return -context.measureText(text.charAt(0)).actualBoundingBoxLeft;
}

/** Left edge of the mark's ink (its leftmost node) inside its square box, as a fraction. */
function markInkLeft() {
  const shift = Number(/translate\(\s*([-\d.]+)/.exec(octoMarkGeometry.transform)?.[1] ?? 0);
  const left = Math.min(...octoMarkGeometry.circles.map((circle) => circle.cx - circle.r)) + shift;
  return left / Number(octoMarkGeometry.viewBox.split(/\s+/)[2]);
}

async function main() {
  const root = document.documentElement.style;
  root.setProperty("--gx", `${P.gx}px`);
  root.setProperty("--grid-top", `${P.gridTop}px`);
  root.setProperty("--ledge", `${P.ledge}px`);
  root.setProperty("--win-w", `${P.winR - P.gx}px`);

  drawMark(document.getElementById("lockup-mark"), true);
  drawMark(document.getElementById("coin-mark"), false);
  for (const coin of document.querySelectorAll("[data-crew]")) {
    const crew = CREW_SLOTS[Number(coin.dataset.crew)];
    coin.style.background = crew.fill;
    coin.style.color = crew.on;
  }

  await document.fonts.ready;

  // One optical left edge: the mark's leftmost node, the headline's G and the
  // sub copy's B all start their ink on the gutter.
  const h1 = document.getElementById("h1");
  const sub = document.getElementById("sub");
  const copy = document.getElementById("copy");
  copy.style.left = `${P.gx - leadingBearing(h1, "G")}px`;
  sub.style.marginLeft = `${leadingBearing(h1, "G") - leadingBearing(sub, "B")}px`;
  const lockup = document.getElementById("lockup");
  const markBox = document.getElementById("lockup-mark").getBoundingClientRect().width;
  lockup.style.left = `${P.gx - markInkLeft() * markBox}px`;

  // The domain sits on the wordmark's baseline, at the right gutter.
  const wordmark = document.getElementById("wordmark");
  const domain = document.getElementById("domain");
  const baseline = (element) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    element.appendChild(probe);
    const y = probe.getBoundingClientRect().top;
    probe.remove();
    return y;
  };
  domain.style.top = "0px";
  domain.style.top = `${baseline(wordmark) - baseline(domain)}px`;

  // The roster stops short of the corner, leaving Cub his perch
  // (landingStudioChrome.ts TOP_BAR), in perch units.
  const roster = document.getElementById("roster");
  roster.style.right = `${Math.round(P.rosterK * P.u)}px`;

  const layer = document.getElementById("cub");
  const origin = layer.getBoundingClientRect();
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  };
  const textLines = [...h1.querySelectorAll("span")].map(rect);
  const range = document.createRange();
  range.selectNodeContents(sub);
  for (const r of range.getClientRects()) {
    textLines.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  }
  const win = rect(document.getElementById("win"));
  const bar = rect(document.getElementById("topbar"));
  const below = { x: win.x + 24, y: bar.y + bar.h + 16, w: win.w - 48, h: 40 };
  const anchors = {
    width: 1200,
    height: 630,
    window: win,
    panel: win,
    transcript: { x: win.x + 16, y: bar.y + bar.h, w: win.w - 32, h: win.h - bar.h },
    floor: below,
    titleRow: rect(document.getElementById("tab")),
    composer: below,
    coins: [...roster.children].map(rect),
    octoCoin: 2,
    textLines,
    cta: null,
    keepOut: [rect(lockup), rect(domain)],
    chrome: [],
    chips: [],
    mobile: false,
    corner: true,
    poi: { title: rect(h1) },
  };

  const status = await new Promise((resolve) => {
    const handle = createCub(layer, {
      anchors,
      theme: LANDING_CUB_THEME.light,
      timeline: LANDING_CUB_TIMELINE,
      layout: { ...LANDING_CUB_LAYOUT, desktopU: { min: P.u, k: 0, max: P.u }, cornerMinWidth: 0 },
      lineWidth: P.lineWidth,
      zIndex: 3,
      eyes: true,
      clickInk: false,
      notice: false,
      still: { t: P.t, td: null },
      dprCap: { desktop: 2, mobile: 2 },
      onStatus: (next) => {
        if (next !== "wait") resolve(next);
      },
    });
    window.__cub = handle;
    setTimeout(() => resolve("timeout"), 15000);
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const state = window.__cub.getState();
  window.__card = { status, mode: state.mode, u: state.u, bx: state.bx, anchors };
  document.body.dataset.ready = status === "on" ? "1" : "err";
}

main().catch((error) => {
  window.__cardError = String((error && error.stack) || error);
  document.body.dataset.ready = "err";
});
