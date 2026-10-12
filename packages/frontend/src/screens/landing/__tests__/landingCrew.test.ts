import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CREW_DARK, DEFAULT_CREW_LIGHT } from "../cub/cubConfig";
import { CREW_DARK_LIFT, CREW_SLOTS, LANDING_CREW } from "../landingCrew";

// The crew palette has three copies: the fixed fill and label pairs the
// landing inlines (which the hero's ink reads too), the theme-aware --crew-N
// variables the logo's crew nodes read, and the engine's own defaults. They
// must never drift apart.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../../styles/tailwind.css"), "utf8");

// Every declaration of a top-level block with this exact selector, merged in
// source order.
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(blocks)) {
    for (const declaration of match[1].split(";")) {
      const [name, ...value] = declaration.split(":");
      if (name?.trim().startsWith("--")) out.set(name.trim(), value.join(":").trim().toLowerCase());
    }
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("landing crew palette", () => {
  it("matches the light --crew-N variables, left to right", () => {
    const root = declarations(":root");
    expect(CREW_SLOTS.map((_, index) => root.get(`--crew-${index + 1}`))).toEqual(
      CREW_SLOTS.map((slot) => slot.fill.toLowerCase()),
    );
    expect(CREW_SLOTS.map((slot) => slot.fill)).toEqual(["#FF3C9F", "#1B864B", "#FA5815", "#814AD0"]);
  });

  it("matches the dark lift, which changes only green and violet", () => {
    const root = declarations(":root");
    const dark = declarations(".dark");
    const darkValues = CREW_SLOTS.map((_, index) => dark.get(`--crew-${index + 1}`) ?? root.get(`--crew-${index + 1}`));
    expect(darkValues).toEqual(CREW_DARK_LIFT.map((hex) => hex.toLowerCase()));
    expect(CREW_DARK_LIFT).toEqual(["#FF3C9F", "#3CA063", "#FA5815", "#A672FA"]);
    expect(dark.has("--crew-1")).toBe(false);
    expect(dark.has("--crew-3")).toBe(false);
  });

  it("is the crew Cub's engine falls back on, light and dark", () => {
    expect([...DEFAULT_CREW_LIGHT]).toEqual(CREW_SLOTS.map((slot) => slot.fill));
    expect([...DEFAULT_CREW_DARK]).toEqual([...CREW_DARK_LIFT]);
  });

  it("gives each fill a label colour that reads on it", () => {
    for (const slot of CREW_SLOTS) {
      expect(contrast(slot.fill, slot.on)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("seats the crew in roster order and never gives Octo a crew colour", () => {
    expect(LANDING_CREW.ada).toBe(CREW_SLOTS[0]);
    expect(LANDING_CREW.kim).toBe(CREW_SLOTS[1]);
    expect(LANDING_CREW.agent).toBe(CREW_SLOTS[2]);
    expect(Object.keys(LANDING_CREW)).not.toContain("octo");
  });
});
