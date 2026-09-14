import { describe, expect, it } from "vitest";
import { resolveProfileDefaults } from "../profileDefaults";

describe("resolveProfileDefaults", () => {
  it("prefers a provider's full name and photo over its username", () => {
    expect(resolveProfileDefaults({
      full_name: "  Alex   Teammate  ", name: "Other name", user_name: "alex-dev",
      avatar_url: " https://example.test/alex.png ", picture: "https://example.test/other.png"
    })).toEqual({ fullName: "Alex Teammate", avatarUrl: "https://example.test/alex.png", bio: null });
  });

  it.each(["name", "display_name", "user_name", "preferred_username", "username"])(
    "uses the %s claim when the preceding names are empty", (key) => {
      expect(resolveProfileDefaults({ full_name: " ", [key]: "alex-dev" }).fullName).toBe("alex-dev");
    }
  );

  it("does not derive a public name from email, including email-valued name claims", () => {
    expect(resolveProfileDefaults({
      email: "alex@example.test", full_name: "alex@example.test", preferred_username: "alex@example.test"
    })).toEqual({ fullName: null, avatarUrl: null, bio: null });
    expect(resolveProfileDefaults({ full_name: "alex@example.test", user_name: "alex-dev" }).fullName).toBe("alex-dev");
  });

  it("ignores malformed claims and supports a provider picture", () => {
    expect(resolveProfileDefaults({ full_name: 42, name: {}, user_name: "alex", avatar_url: false,
      picture: "https://example.test/photo.png" })).toEqual({ fullName: "alex", avatarUrl: "https://example.test/photo.png", bio: null });
    for (const value of [null, undefined, [], "name"]) {
      expect(resolveProfileDefaults(value)).toEqual({ fullName: null, avatarUrl: null, bio: null });
    }
  });
});
