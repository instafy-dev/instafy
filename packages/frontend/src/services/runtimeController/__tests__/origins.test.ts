import { describe, expect, it } from "vitest";

import { mapOriginSummaryToLocalWorkspacePresence } from "../origins";

describe("mapOriginSummaryToLocalWorkspacePresence", () => {
  it("falls back to originId when summary and metadata device ids are blank", () => {
    const workspace = mapOriginSummaryToLocalWorkspacePresence({
      originId: "origin-123",
      endpoint: "http://localhost:8788/origin/origin-123",
      mode: "hosted",
      deviceId: null,
      metadata: {
        deviceId: "   ",
      },
      presence: null,
    });

    expect(workspace).toMatchObject({
      deviceId: "origin-123",
      status: "online",
      presenceStatus: null,
    });
  });
});
