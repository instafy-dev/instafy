import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  browserRequestDestinations,
  browserRequestFromMessage,
  browserRequestUnavailableReason,
  type BrowserRequest,
} from "../browserRequest";

function card(browserRequest: Record<string, unknown>, id = "card"): ChatMessage {
  return { id, role: "assistant", content: "Continue this task in your browser.", timestamp: 2,
    metadata: { messageType: "action_request", details: { browserRequest } } };
}

describe("browserRequestDestinations", () => {
  it("names each host the task opens, once, in order", () => {
    expect(browserRequestDestinations(
      "Open https://app.freefinance.at/login and take me to Einstellungen, then Verbundene Apps. "
      + "If it asks, the demo is at https://demo.freefinance.at. Back on https://APP.freefinance.at/ stop.",
    )).toEqual(["app.freefinance.at", "demo.freefinance.at"]);
  });

  it("reads a task that opens a bare host", () => {
    expect(browserRequestDestinations("Open app.example.com and take me to Settings, then API.")).toEqual(["app.example.com"]);
    expect(browserRequestDestinations("Go to portal.example.co.uk/settings.")).toEqual(["portal.example.co.uk"]);
  });

  it("names nothing when the task gives no address", () => {
    expect(browserRequestDestinations("Continue comparing the saved items from earlier.")).toEqual([]);
    expect(browserRequestDestinations("Check the docs for Next.js and node.js.")).toEqual([]);
  });

  it("shows a look-alike address as the host it really opens", () => {
    expect(browserRequestDestinations("Open https://app.example.com@evil.example/ and stop.")).toEqual(["evil.example"]);
  });
});

describe("browserRequestUnavailableReason", () => {
  const request = (location: BrowserRequest["location"]): BrowserRequest =>
    ({ task: "Open https://app.example.test", location });
  const web = { transport: "shared" as const, personalAvailable: false, sharedUnavailable: false };

  it("allows a card any browser here can open, counting a browser not known yet as available", () => {
    // Instafy's browser starts on demand as a runtime of its own, so until it
    // is known not to open here it counts as available.
    expect(browserRequestUnavailableReason(request("auto"), web)).toBeNull();
    expect(browserRequestUnavailableReason(request("workspace"), web)).toBeNull();
    // The Workspace browser cannot open, but this device's can.
    expect(browserRequestUnavailableReason(request("auto"), { ...web, sharedUnavailable: true, personalAvailable: true })).toBeNull();
  });

  it("explains a card no browser here can open", () => {
    expect(browserRequestUnavailableReason(request("auto"), { ...web, sharedUnavailable: true }))
      .toBe("Instafy's browser is not available in this workspace.");
    expect(browserRequestUnavailableReason(request("workspace"), { ...web, sharedUnavailable: true, personalAvailable: true }))
      .toBe("Instafy's browser is not available in this workspace.");
    expect(browserRequestUnavailableReason(request("device"), web)).toContain("Instafy desktop app");
  });

  it("takes nothing about availability from the card itself", () => {
    // A runtime once marked its cards `workspaceBrowser: false` from its own
    // setting, which the runtime running a chat turn never has.
    const parsed = browserRequestFromMessage(card({ task: "Open x", location: "auto", workspaceBrowser: false }));
    expect(parsed).toEqual({ task: "Open x", location: "auto" });
    expect(browserRequestUnavailableReason(parsed!, web)).toBeNull();
  });
});
