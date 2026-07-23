import { describe, expect, it } from "vitest";
import {
  OCTO_AVATAR_SRC,
  normalizeCustomAgentAvatarSrc,
  resolveAgentAvatarImageSrc,
} from "../agentAvatar";

describe("agentAvatar", () => {
  it("accepts data urls as custom avatar sources", () => {
    expect(normalizeCustomAgentAvatarSrc("data:image/png;base64,ZmFrZQ==")).toBe(
      "data:image/png;base64,ZmFrZQ==",
    );
  });

  it("resolves octo to the bundled avatar asset", () => {
    // Vite emits small assets as inline data URIs and larger ones as file URLs.
    expect(OCTO_AVATAR_SRC).toMatch(/^data:image\/svg\+xml|\.svg$/);
    expect(resolveAgentAvatarImageSrc({ handle: "octo" })).toBe(OCTO_AVATAR_SRC);
    expect(resolveAgentAvatarImageSrc({ handle: "ai" })).toBe(OCTO_AVATAR_SRC);
  });
});
