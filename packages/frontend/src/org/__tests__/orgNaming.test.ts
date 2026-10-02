import { describe, expect, it } from "vitest";
import { getOrgInitials } from "../orgNaming";

describe("team avatar initials", () => {
  it.each(["Personal team", "Personal", " Personal team ", "Personal organization", "Personal workspace"])(
    "gives the personal team one letter whichever name a screen holds (%s)",
    (name) => {
      expect(getOrgInitials(name)).toBe("P");
    },
  );

  it("uses the first letter of the first two words of any other team", () => {
    expect(getOrgInitials("Research team")).toBe("RT");
    expect(getOrgInitials("acme design studio")).toBe("AD");
    expect(getOrgInitials("Acme")).toBe("A");
  });

  it("keeps a placeholder for a team whose name has not loaded", () => {
    expect(getOrgInitials("")).toBe("?");
    expect(getOrgInitials("   ")).toBe("?");
  });
});
