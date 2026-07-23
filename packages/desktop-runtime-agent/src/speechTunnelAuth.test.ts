import { describe, expect, it } from "vitest";

import { supportsSpeechTunnelStatusUpdates } from "./speechTunnelAuth.js";

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildJwt(payload: Record<string, unknown>) {
  return [
    encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    encodeBase64Url(JSON.stringify(payload)),
    "signature",
  ].join(".");
}

describe("supportsSpeechTunnelStatusUpdates", () => {
  it("rejects normal authenticated user tokens", () => {
    const token = buildJwt({
      sub: "user-id",
      role: "authenticated",
      aud: "authenticated",
    });

    expect(
      supportsSpeechTunnelStatusUpdates(
        token,
        "5b7d1f88-3f78-4ca1-90a1-3f7d4dc5c3a8",
      ),
    ).toBe(false);
  });

  it("accepts service role jwt tokens", () => {
    const token = buildJwt({
      sub: "service-role",
      role: "service_role",
      aud: "service_role",
    });

    expect(
      supportsSpeechTunnelStatusUpdates(
        token,
        "5b7d1f88-3f78-4ca1-90a1-3f7d4dc5c3a8",
      ),
    ).toBe(true);
  });

  it("accepts scoped runtime tokens for the same project", () => {
    const projectId = "5b7d1f88-3f78-4ca1-90a1-3f7d4dc5c3a8";
    const token = buildJwt({
      sub: "runtime-token",
      aud: "instafy-runtime",
      project_id: projectId,
      scopes: ["origin.register", "origin.presence"],
    });

    expect(supportsSpeechTunnelStatusUpdates(token, projectId)).toBe(true);
  });

  it("rejects scoped runtime tokens for a different project", () => {
    const token = buildJwt({
      sub: "runtime-token",
      aud: "instafy-runtime",
      project_id: "1894a981-f60f-4b5c-9d57-f95fb229f76a",
      scopes: ["origin.register", "origin.presence"],
    });

    expect(
      supportsSpeechTunnelStatusUpdates(
        token,
        "5b7d1f88-3f78-4ca1-90a1-3f7d4dc5c3a8",
      ),
    ).toBe(false);
  });

  it("allows opaque tokens because they may be direct controller credentials", () => {
    expect(
      supportsSpeechTunnelStatusUpdates(
        "controller-internal-token",
        "5b7d1f88-3f78-4ca1-90a1-3f7d4dc5c3a8",
      ),
    ).toBe(true);
  });
});
