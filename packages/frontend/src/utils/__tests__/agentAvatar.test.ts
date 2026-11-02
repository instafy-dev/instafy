import { describe, expect, it } from "vitest";
import { normalizeCustomAgentAvatarSrc } from "../agentAvatar";

// Octo by handle, aliases included, is resolveAiFace's (utils/__tests__/aiFace.test.ts).
describe("agentAvatar", () => {
  it("accepts data urls as custom avatar sources", () => {
    expect(normalizeCustomAgentAvatarSrc("data:image/png;base64,ZmFrZQ==")).toBe(
      "data:image/png;base64,ZmFrZQ==",
    );
  });
});
