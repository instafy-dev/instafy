import { describe, expect, it } from "vitest";

import {
  formatControllerUnavailableDetail,
  formatRuntimeStreamDisconnectedMessage,
  isLikelyControllerConnectionError,
} from "../controllerConnectionErrors";

describe("controllerConnectionErrors", () => {
  it("detects generic fetch failures as controller connection errors", () => {
    expect(
      isLikelyControllerConnectionError("Unable to load credentials: Failed to fetch"),
    ).toBe(true);
  });

  it("detects runtime stream failures as controller connection errors", () => {
    expect(isLikelyControllerConnectionError("event stream error")).toBe(true);
  });

  it("does not treat ordinary credential copy as a connection failure", () => {
    expect(
      isLikelyControllerConnectionError("Missing controller session token."),
    ).toBe(false);
  });

  it("formats a friendly runtime stream toast for generic transport failures", () => {
    expect(formatRuntimeStreamDisconnectedMessage("event stream error")).toBe(
      "Lost live runtime updates. Retrying…",
    );
  });

  it("formats a friendly controller-unavailable detail for generic transport failures", () => {
    expect(
      formatControllerUnavailableDetail("Unable to load credentials: Failed to fetch"),
    ).toBe("Retry after the local stack is ready. Your AI credentials may still be fine.");
  });
});
