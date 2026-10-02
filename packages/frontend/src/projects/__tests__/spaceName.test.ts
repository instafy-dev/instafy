import { describe, expect, it } from "vitest";
import { isUntitledSpaceName, realSpaceName, spaceDisplayName, UNTITLED_SPACE_NAME } from "../spaceName";

const PLACEHOLDERS = [null, undefined, "", "   ", "Untitled Space", "untitled space", " Untitled space ", "Untitled Instafy Project"];

describe("space names", () => {
  it("treats a missing name and every old placeholder as untitled", () => {
    for (const name of PLACEHOLDERS) {
      expect(isUntitledSpaceName(name)).toBe(true);
      expect(spaceDisplayName(name)).toBe(UNTITLED_SPACE_NAME);
      expect(realSpaceName(name)).toBeNull();
    }
    expect(UNTITLED_SPACE_NAME).toBe("Untitled space");
  });

  it("keeps a real name as typed, trimmed", () => {
    for (const name of ["FreeFinance", " Books 2026 ", "Untitled space plans"]) {
      expect(isUntitledSpaceName(name)).toBe(false);
      expect(spaceDisplayName(name)).toBe(name.trim());
      expect(realSpaceName(name)).toBe(name.trim());
    }
  });
});
