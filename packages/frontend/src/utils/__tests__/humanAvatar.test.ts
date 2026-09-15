import { describe, expect, it } from "vitest";
import { resolveHumanAvatarColors, resolveHumanAvatarInitials } from "../humanAvatar";

describe("human avatar identity", () => {
  it.each([
    [" Example User ", "EU"],
    ["Ada", "AD"],
    ["Mary Jane Watson", "MW"],
    ["Émile Zola", "ÉZ"],
    ["李 明", "李明"],
  ])("uses a person's name for initials: %s", (name, initials) => {
    expect(resolveHumanAvatarInitials(name)).toBe(initials);
  });

  it.each([null, undefined, "", "  ", "someone@example.test", " You ", "Guest", "Account", "Teammate", "Owner"])(
    "keeps unnamed and email identities generic: %s", (name) => {
      expect(resolveHumanAvatarInitials(name)).toBeNull();
    },
  );

  it("uses a repeatable palette based only on stable user IDs", () => {
    const colors = resolveHumanAvatarColors("user-42");
    expect(resolveHumanAvatarColors(" user-42 ")).toEqual(colors);
    expect(resolveHumanAvatarColors("user-42")).toEqual(colors);
    expect(new Set(Array.from({ length: 24 }, (_, id) => resolveHumanAvatarColors(`user-${id}`).background)).size).toBeGreaterThan(3);
    expect(resolveHumanAvatarColors(null)).toEqual(resolveHumanAvatarColors(undefined));
  });

  it("keeps initials legible on every light and dark fallback color", () => {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (let id = 0; id < 24; id++) {
      const colors = resolveHumanAvatarColors(`user-${id}`);
      for (const [background, foreground] of [[colors.background, colors.foreground], [colors.darkBackground, colors.darkForeground]]) {
        const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
        expect((values[0] + 0.05) / (values[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
