// Helpers for hosts that measure anchors from the DOM: rects relative to the
// host, per-line rects of text (so a short last line does not block a whole
// box), and coin rects with any CSS scale undone (a popped coin still reports
// its resting size). Ported from the owner-approved prototype (not in this repo).

import type { CubAnchors, CubRect } from "./cubTypes";

/** el's rect relative to the host rect hr, in css px. */
export function rectIn(el: Element, hr: DOMRectReadOnly): CubRect {
  const r = el.getBoundingClientRect();
  return { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
}

/** One rect per rendered line of el's text, padded 2 px each side (empty when el is not rendered). */
export function lineRects(el: HTMLElement | null, hr: DOMRectReadOnly): CubRect[] {
  if (!el || !el.offsetParent) return [];
  const rg = el.ownerDocument.createRange();
  rg.selectNodeContents(el);
  return [...rg.getClientRects()]
    .filter((r) => r.width > 2 && r.height > 2)
    .map((r) => ({ x: r.left - hr.left - 2, y: r.top - hr.top, w: r.width + 4, h: r.height }));
}

/**
 * el's layout rect with its own CSS transform undone (a pop scale about its
 * centre, a slide-in offset), centred where it would render untransformed. A
 * coin that is popped, pressed or sliding in still reports its resting place,
 * so the layout does not change with the beat.
 */
export function rectBase(el: HTMLElement, hr: DOMRectReadOnly): CubRect {
  const r = el.getBoundingClientRect();
  const w = el.offsetWidth || r.width;
  const h = el.offsetHeight || r.height;
  // The offset of the box's centre: the transform's translation (a scale
  // about the centre leaves it in place) plus the individual translate
  // property (Tailwind's translate utilities).
  let tx = 0;
  let ty = 0;
  const view = el.ownerDocument.defaultView;
  const cs = view ? view.getComputedStyle(el) : null;
  const tf = cs ? cs.transform : "";
  const m = tf && tf !== "none" ? /^matrix\(([^)]+)\)$/.exec(tf) : null;
  if (m) {
    const v = m[1].split(",").map(Number);
    if (v.length === 6 && Number.isFinite(v[4]) && Number.isFinite(v[5])) {
      tx = v[4];
      ty = v[5];
    }
  }
  const tr = cs && typeof cs.translate === "string" && cs.translate !== "none" ? cs.translate.split(/\s+/).map(parseFloat) : [];
  if (Number.isFinite(tr[0])) tx += tr[0];
  if (Number.isFinite(tr[1])) ty += tr[1];
  return { x: r.left + r.width / 2 - tx - w / 2 - hr.left, y: r.top + r.height / 2 - ty - h / 2 - hr.top, w, h };
}

export interface CubAnchorElements {
  window: HTMLElement;
  panel: HTMLElement;
  transcript: HTMLElement;
  floor: HTMLElement;
  titleRow: HTMLElement;
  composer: HTMLElement;
  /** Roster coins in reading order, Octo's included. */
  coins: HTMLElement[];
  octoCoin: HTMLElement;
  /** Elements whose text lines are keep-outs (headline, sub copy). */
  text: (HTMLElement | null)[];
  cta?: HTMLElement | null;
  keepOut?: (HTMLElement | null)[];
  /** Small window chrome (tab-strip action glyphs): arm and ink keep-outs that never move the perch. */
  chrome?: (Element | null)[];
  chips?: HTMLElement[];
  poi?: { own?: HTMLElement | null; octoMessage?: HTMLElement | null; file?: HTMLElement | null; title?: HTMLElement | null };
}

/** Measures every anchor relative to host. */
export function anchorsFromElements(host: HTMLElement, e: CubAnchorElements): CubAnchors {
  const hr = host.getBoundingClientRect();
  const opt = (el: HTMLElement | null | undefined) => (el ? rectIn(el, hr) : null);
  const coins = e.coins.map((el) => rectBase(el, hr));
  return {
    width: Math.round(hr.width),
    height: Math.round(hr.height),
    window: rectIn(e.window, hr),
    panel: rectIn(e.panel, hr),
    transcript: rectIn(e.transcript, hr),
    floor: rectIn(e.floor, hr),
    titleRow: rectIn(e.titleRow, hr),
    composer: rectIn(e.composer, hr),
    coins,
    octoCoin: Math.max(0, e.coins.indexOf(e.octoCoin)),
    textLines: e.text.flatMap((el) => lineRects(el, hr)),
    cta: opt(e.cta),
    keepOut: (e.keepOut ?? []).filter((el): el is HTMLElement => !!el).map((el) => rectIn(el, hr)),
    chrome: (e.chrome ?? []).filter((el): el is Element => !!el).map((el) => rectIn(el, hr)),
    chips: (e.chips ?? []).map((el) => rectIn(el, hr)),
    poi: {
      own: opt(e.poi?.own),
      octoMessage: opt(e.poi?.octoMessage),
      file: opt(e.poi?.file),
      title: opt(e.poi?.title),
    },
  };
}
