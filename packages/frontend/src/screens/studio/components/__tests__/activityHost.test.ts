import { describe, expect, it } from "vitest";
import { decodePunycodeLabel, displayActivityHost } from "../activityHost";

describe("displayActivityHost", () => {
  it("decodes punycode labels (RFC 3492)", () => {
    expect(decodePunycodeLabel("mnchen-3ya")).toBe("münchen");
    expect(decodePunycodeLabel("e1afmkfd")).toBe("пример");
    expect(decodePunycodeLabel("p1ai")).toBe("рф");
    expect(decodePunycodeLabel("wgv71a119e")).toBe("日本語");
    expect(decodePunycodeLabel("!!!")).toBeNull();
  });

  it("shows a name in one script in Unicode", () => {
    expect(displayActivityHost("visitlisboa.com")).toBe("visitlisboa.com");
    expect(displayActivityHost("xn--mnchen-3ya.de")).toBe("münchen.de");
    expect(displayActivityHost("xn--e1afmkfd.xn--p1ai")).toBe("пример.рф");
    // CJK with a Latin top-level domain is one of the mixes names are written in.
    expect(displayActivityHost("xn--wgv71a119e.jp")).toBe("日本語.jp");
  });

  it("keeps a name that mixes scripts, or does not decode, as the runtime named it", () => {
    // A Cyrillic "а" in a Latin name.
    expect(displayActivityHost("xn--pple-43d.com")).toBe("xn--pple-43d.com");
    expect(displayActivityHost("xn--e1afmkfd.com")).toBe("xn--e1afmkfd.com");
    expect(displayActivityHost("xn--zz.com")).toBe("xn--zz.com");
  });
});
