import { describe, expect, it } from "vitest";

import {
  mapOriginSummaryFromPayload,
  mapOriginSummaryToLocalWorkspacePresence,
} from "../origins";

describe("mapOriginSummaryFromPayload", () => {
  it("preserves the controller-verified runtime binding", () => {
    const summary = mapOriginSummaryFromPayload({
      originId: "origin-123",
      runtimeId: "runtime-456",
      endpoint: "http://runtime.invalid",
      mode: "hosted",
    });

    expect(summary).toMatchObject({
      originId: "origin-123",
      runtimeId: "runtime-456",
    });
  });
});

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
