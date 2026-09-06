import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

describe("loading motion preferences", () => {
  const css = postcss.parse(readFileSync(new URL("../tailwind.css", import.meta.url), "utf8"));
  const reducedRules = new Map<string, Record<string, string>>();
  css.walkAtRules("media", (media) => {
    if (media.params !== "(prefers-reduced-motion: reduce)") return;
    media.walkRules((rule) => {
      const declarations: Record<string, string> = {};
      rule.walkDecls((declaration) => { declarations[declaration.prop] = declaration.value; });
      rule.selectors.forEach((selector) => reducedRules.set(selector, declarations));
    });
  });

  it("stops shared and raw loading indicators for reduced motion", () => {
    for (const selector of [
      ".animate-spin", ".animate-pulse", ".animate-ping",
      ".instafy-compact-event-pill", ".instafy-compact-overflow-pill", ".instafy-compact-event-pill-live",
    ]) {
      expect(reducedRules.get(selector)?.animation, selector).toBe("none");
    }
  });

  it("removes the moving text overlay while retaining the readable base label", () => {
    expect(reducedRules.get(".instafy-status-sweep::after")?.animation).toBe("none");
    expect(reducedRules.get(".instafy-status-sweep::after")?.content).toBe("none");
    expect(reducedRules.get(".instafy-status-sweep")?.display).not.toBe("none");
  });
});
