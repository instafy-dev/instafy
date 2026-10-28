import { describe, expect, it } from "vitest";
import { composerBrowserActions } from "../composerBrowserActions";

describe("composerBrowserActions", () => {
  it("offers Open browser while none is open, and no new-tab request", () => {
    expect(composerBrowserActions({ transport: "shared", browserOpen: false }))
      .toEqual({ showBrowserAction: true, showNewBrowserAction: false });
    expect(composerBrowserActions({ transport: "personal", browserOpen: false }))
      .toEqual({ showBrowserAction: true, showNewBrowserAction: false });
  });

  it("offers Ask AI for a new tab only while the Shared Browser is open", () => {
    expect(composerBrowserActions({ transport: "shared", browserOpen: true }))
      .toEqual({ showBrowserAction: false, showNewBrowserAction: true });
    expect(composerBrowserActions({ transport: "personal", browserOpen: true }))
      .toEqual({ showBrowserAction: false, showNewBrowserAction: false });
  });
});
