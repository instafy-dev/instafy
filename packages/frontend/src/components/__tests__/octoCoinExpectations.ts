import { expect } from "vitest";

import { AI_TILE_EDGE_CLASS, AI_TILE_SHAPE_CLASS, OCTO_COIN_CLASS, OCTO_COIN_MARK_CLASS } from "../OctoCoin";

export function classTokens(element: Element | null | undefined): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

// jsdom cannot resolve Tailwind's dark: variants, so Octo's tile is
// read from its classes (docs/Brand.md, "Octo agent avatar/chip"): in light a
// white rounded square edged by the shared avatar coin shadow and the AI
// tile's ink hairline (no grey border, no ring); in dark the neutral tile,
// the faint light ring as its hairline and the brand-paper mark. The mark
// stays one ink.
export const AVATAR_COIN_SHADOW_CLASS = "shadow-avatar-coin";
export const AI_TILE_EDGE_TOKENS = AI_TILE_EDGE_CLASS.split(" ");
export const OCTO_COIN_LIGHT_TOKENS = ["bg-white", AVATAR_COIN_SHADOW_CLASS, "outline-ai-tile-edge"] as const;
export const OCTO_COIN_DARK_TOKENS = ["dark:bg-octo-coin-dark", "dark:outline-octo-coin-ring-dark"] as const;

/**
 * One rule for faces (docs/Brand.md): every AI face (Octo, its helpers, saved
 * agents) is the 30% rounded square with the AI tile's inside hairline, and
 * never a circle.
 */
export function expectAiTile(face: Element | null | undefined) {
  expect(face).toBeInstanceOf(Element);
  const tokens = classTokens(face);
  expect(tokens).toContain(AI_TILE_SHAPE_CLASS);
  expect(tokens).toEqual(expect.arrayContaining(AI_TILE_EDGE_TOKENS));
  expect(tokens).not.toContain("rounded-full");
  return tokens;
}

/**
 * People are always round and never wear the AI tile, nor any outline: the
 * inside hairline is an AI tile's alone.
 */
export function expectPersonCircle(face: Element | null | undefined) {
  expect(face).toBeInstanceOf(Element);
  const tokens = classTokens(face);
  expect(tokens).toContain("rounded-full");
  expect(tokens).not.toContain(AI_TILE_SHAPE_CLASS);
  expect(tokens.filter((token) => /^(dark:)?-?outline(-|$)/.test(token))).toEqual([]);
  return tokens;
}

/**
 * Every face, a person's coin and every AI's tile alike, has one light-mode
 * shadow: the shared avatar coin shadow (docs/Brand.md). No light grey
 * border, ring or other shadow; dark edges (dark:*) stay each face's own. An
 * AI tile adds its inside hairline, an outline (expectAiTile checks it), which
 * this border/shadow/ring check leaves alone. `allow` names light tokens a
 * stack's separator needs (border border-white).
 */
export function expectAvatarCoinLightEdge(face: Element | null | undefined, allow: readonly string[] = []) {
  expect(face).toBeInstanceOf(Element);
  const tokens = classTokens(face);
  expect(tokens).toContain(AVATAR_COIN_SHADOW_CLASS);
  expect(
    tokens.filter((token) => /^(border|shadow|ring)(-|$)/.test(token) && token !== AVATAR_COIN_SHADOW_CLASS && !allow.includes(token)),
  ).toEqual([]);
  return tokens;
}

export function expectCanonicalOctoCoin(coin: Element | null | undefined) {
  expect(coin).toBeInstanceOf(Element);
  expect(coin!.hasAttribute("data-octo-coin")).toBe(true);
  expect(coin!.getAttribute("aria-hidden")).toBe("true");
  const tokens = classTokens(coin);
  expect(tokens).toEqual(expect.arrayContaining(OCTO_COIN_CLASS.split(" ")));
  expect(tokens).toEqual(expect.arrayContaining([...OCTO_COIN_LIGHT_TOKENS, ...OCTO_COIN_DARK_TOKENS]));
  expectAiTile(coin);
  // The tile's edges are the shared coin shadow and the AI tile's hairline,
  // and nothing else: no border, no ring, no other shadow or outline.
  const edgeTokens: readonly string[] = [AVATAR_COIN_SHADOW_CLASS, ...AI_TILE_EDGE_TOKENS];
  expect(
    tokens.filter((token) => /^(dark:)?-?(border|shadow|ring|outline)(-|$)/.test(token) && !edgeTokens.includes(token)),
  ).toEqual([]);
  // The light brand-ink ring is gone for good.
  expect(tokens.filter((token) => token.includes("brand-ink"))).toEqual([]);

  const mark = coin!.querySelector(":scope > svg.octo-mark");
  expect(mark).not.toBeNull();
  const markTokens = classTokens(mark);
  expect(markTokens).toEqual(expect.arrayContaining(OCTO_COIN_MARK_CLASS.split(" ")));
  expect(markTokens).toEqual(expect.arrayContaining(["text-brand-ink", "dark:text-brand-paper"]));
  // One ink: never the crew colorway, never a tinted node.
  expect(mark!.hasAttribute("data-octo-colorway")).toBe(false);
  expect(markTokens.filter((token) => token.startsWith("octo-mark--crew"))).toEqual([]);
  expect(mark!.querySelectorAll("circle[style]")).toHaveLength(0);
  return mark as SVGSVGElement;
}
