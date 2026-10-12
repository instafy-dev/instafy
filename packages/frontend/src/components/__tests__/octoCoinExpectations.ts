import { expect } from "vitest";

import { OCTO_COIN_CLASS, OCTO_COIN_MARK_CLASS } from "../OctoCoin";

export function classTokens(element: Element | null | undefined): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

// jsdom cannot resolve Tailwind's dark: variants, so Octo's coin is
// read from its classes (docs/Brand.md, "Octo agent avatar/chip"): in light a
// white coin edged only by the shared avatar coin shadow every avatar coin
// carries (no ring, no grey border); in dark the neutral coin, a faint light
// ring and the brand-paper mark. The mark stays one ink.
export const AVATAR_COIN_SHADOW_CLASS = "shadow-avatar-coin";
export const OCTO_COIN_LIGHT_TOKENS = ["bg-white", AVATAR_COIN_SHADOW_CLASS] as const;
export const OCTO_COIN_DARK_TOKENS = [
  "dark:bg-octo-coin-dark",
  "dark:shadow-[inset_0_0_0_1px_var(--color-octo-coin-ring-dark)]",
] as const;

/**
 * Every avatar coin, Octo's, people's and other agents', has one light-mode
 * edge: the shared avatar coin shadow (docs/Brand.md). No light grey border,
 * ring or other shadow; dark edges (dark:*) stay each coin's own. `allow`
 * names light tokens a stack's separator needs (border border-white).
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
  // The coin's edges are the shared coin shadow in light and the faint inset
  // ring in dark, and nothing else: no border, no ring, no other shadow.
  const edgeTokens: readonly string[] = [OCTO_COIN_LIGHT_TOKENS[1], OCTO_COIN_DARK_TOKENS[1]];
  expect(
    tokens.filter((token) => /^(dark:)?(border|shadow|ring)(-|$)/.test(token) && !edgeTokens.includes(token)),
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
