import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  browserRequestDestinations,
  browserRequestFromMessage,
  browserRequestInSkillSetup,
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
  const request = (location: BrowserRequest["location"], workspaceBrowser = true): BrowserRequest =>
    ({ task: "Open https://app.example.test", location, workspaceBrowser });

  it("allows a card any browser here can open", () => {
    const host = { transport: "shared" as const, personalAvailable: false, sharedUnavailable: false };
    expect(browserRequestUnavailableReason(request("auto"), host)).toBeNull();
    expect(browserRequestUnavailableReason(request("workspace"), host)).toBeNull();
    // The Workspace browser cannot open, but this device's can.
    expect(browserRequestUnavailableReason(request("auto", false), { ...host, personalAvailable: true })).toBeNull();
  });

  it("explains a card no browser here can open", () => {
    const web = { transport: "shared" as const, personalAvailable: false, sharedUnavailable: false };
    expect(browserRequestUnavailableReason(request("auto", false), web)).toBe("Instafy's browser is not available in this workspace.");
    expect(browserRequestUnavailableReason(request("workspace"), { ...web, sharedUnavailable: true, personalAvailable: true }))
      .toBe("Instafy's browser is not available in this workspace.");
    expect(browserRequestUnavailableReason(request("device"), web)).toContain("Instafy desktop app");
  });

  it("reads the runtime's own word on its browser from the card", () => {
    expect(browserRequestFromMessage(card({ task: "Open x", location: "auto", workspaceBrowser: false }))?.workspaceBrowser).toBe(false);
    expect(browserRequestFromMessage(card({ task: "Open x", location: "auto" }))?.workspaceBrowser).toBe(true);
  });
});

describe("browserRequestInSkillSetup", () => {
  const opener = (content: string): ChatMessage => ({ id: "opener", role: "user", content, timestamp: 1 });

  it("finds a setup opener before the card", () => {
    const browserCard = card({ task: "Open x", location: "auto" });
    expect(browserRequestInSkillSetup([opener("/skills import https://github.com/acme/skills --start"), browserCard], "card")).toBe(true);
    expect(browserRequestInSkillSetup([opener("/skills start freefinance"), browserCard], "card")).toBe(true);
  });

  it("ignores an import without --start, an opener after the card and an unknown card", () => {
    const browserCard = card({ task: "Open x", location: "auto" });
    expect(browserRequestInSkillSetup([opener("/skills import https://github.com/acme/skills"), browserCard], "card")).toBe(false);
    expect(browserRequestInSkillSetup([browserCard, { ...opener("/skills start freefinance"), id: "later" }], "card")).toBe(false);
    expect(browserRequestInSkillSetup([opener("/skills start freefinance"), browserCard], "another-card")).toBe(false);
  });
});
