// The social card's script, bundled by scripts/generate-og-image.mjs (Vite,
// production mode) into card.js. It draws the real Octo mark from its canonical
// geometry, lays the card out, and mounts the shipping Cub engine with the
// landing's own theme, perch tuning and timeline for one deterministic frame:
// a still, or (ink) a live moment on the fake clock the generator steps.
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
  /** The headline block's top. */
  copyTop: 148,
  /** The window's top edge: the ledge Cub sits on and his ink lands on. */
  ledge: 568,
  /** The window's right end: Cub's corner. */
  winR: 1088,
  /** The roster's right end lies this many perch units left of the corner. */
  rosterK: 2.75,
  /** Cub's perch size (the landing clamps it between 48 and 84 px; a card can afford more). */
  u: 112,
  /** Cub's pen width. */
  lineWidth: 2.9,
  /** Still frames only (ink: 0): Cub's sim time (s), an idle frame with both front arms on the ledge, eyes open. */
  t: 9,
  /** 1: the window's top bar with the conversation title and the roster; 0: a plain slab, the ledge alone. */
  bar: 0,
  /**
   * 1: Cub's crew ink instead of the still frame. He runs live on the
   * generator's fake clock, is booped `settle` s after he boots and is shot
   * `inkMs` ms later (these catch the four splats landed, his squint over and
   * his eyes on the ink). `settle` also seeds the splats' shapes.
   */
  ink: 1,
  settle: 7,
  inkMs: 1250,
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

/**
 * Resolves once a resize and an intersection observer made after Cub's have
 * reported, so his own first reports are in. They arrive on a real frame, not
 * on the fake clock an ink card runs on: one landing mid-run would reschedule
 * his frames.
 */
function observersReported(element) {
  return Promise.all(
    [ResizeObserver, IntersectionObserver].map(
      (Observer) =>
        new Promise((resolve) => {
          const observer = new Observer(() => {
            observer.disconnect();
            resolve();
          });
          observer.observe(element);
        }),
    ),
  );
}

async function main() {
  const root = document.documentElement.style;
  root.setProperty("--gx", `${P.gx}px`);
  root.setProperty("--grid-top", `${P.gridTop}px`);
  root.setProperty("--copy-top", `${P.copyTop}px`);
  root.setProperty("--ledge", `${P.ledge}px`);
  root.setProperty("--win-w", `${P.winR - P.gx}px`);
  document.getElementById("card").dataset.bar = String(P.bar);

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
  // A slab hides the bar but keeps its height, so Cub's front arms hang as deep.
  const bar = rect(document.getElementById("topbar"));
  const below = { x: win.x + 24, y: bar.y + bar.h + 16, w: win.w - 48, h: 40 };
  const anchors = {
    width: 1200,
    height: 630,
    window: win,
    panel: win,
    transcript: { x: win.x + 16, y: bar.y + bar.h, w: win.w - 32, h: win.h - bar.h },
    floor: below,
    titleRow: P.bar ? rect(document.getElementById("tab")) : { x: win.x, y: win.y, w: 0, h: 0 },
    composer: below,
    // A slab keeps only Octo's coin, unseen: the engine's reach target.
    coins: P.bar ? [...roster.children].map(rect) : [rect(roster.children[2])],
    octoCoin: P.bar ? 2 : 0,
    textLines,
    cta: null,
    keepOut: [rect(lockup), rect(domain)],
    chrome: [],
    chips: [],
    mobile: false,
    corner: true,
    poi: { title: rect(h1) },
  };

  // The page runs on the generator's fake clock, paused until Cub is mounted;
  // an ink card notes when he booted, the time its boop is counted from.
  let bootAt = null;
  const booted = new Promise((resolve) => {
    const handle = createCub(layer, {
      anchors,
      theme: LANDING_CUB_THEME.light,
      timeline: LANDING_CUB_TIMELINE,
      layout: { ...LANDING_CUB_LAYOUT, desktopU: { min: P.u, k: 0, max: P.u }, cornerMinWidth: 0 },
      lineWidth: P.lineWidth,
      zIndex: 3,
      eyes: true,
      clickInk: !!P.ink,
      notice: false,
      still: P.ink ? null : { t: P.t, td: null },
      dprCap: { desktop: 2, mobile: 2 },
      onStatus: (next) => {
        if (next === "wait") return;
        bootAt = performance.now();
        resolve(next);
      },
    });
    window.__cub = handle;
    setTimeout(() => resolve("timeout"), 15000);
  });
  await observersReported(layer);
  document.body.dataset.mounted = "1";
  const status = await booted;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const state = window.__cub.getState();
  const ink = P.ink ? { bootAt, settle: P.settle, inkMs: P.inkMs } : null;
  window.__card = { status, mode: state.mode, u: state.u, bx: state.bx, anchors, ink };
  document.body.dataset.ready = status === "on" ? "1" : "err";
}

main().catch((error) => {
  window.__cardError = String((error && error.stack) || error);
  document.body.dataset.ready = "err";
});
