import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  browserRequestContinuedKeys,
  browserRequestDestinations,
  browserRequestFromMessage,
  browserRequestKey,
  browserRequestNotice,
  browserRequestTransport,
  browserRequestUnavailableReason,
  isBrowserTurnPromptMetadata,
  readBrowserRequestOf,
  type BrowserRequest,
} from "../browserRequest";

function card(browserRequest: Record<string, unknown>, id = "card"): ChatMessage {
  return { id, role: "assistant", content: "Continue this task in Instafy's browser.", timestamp: 2,
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

describe("browserRequestTransport on Desktop with Instafy AI", () => {
  const request = (location: BrowserRequest["location"]): BrowserRequest => ({ task: "Open https://app.example.test", location });
  const desktop = { personalAvailable: true, sharedUnavailable: false, personalTurnsAllowed: false };

  it("sends an automatic card to Instafy's browser, which dispatch accepts", () => {
    expect(browserRequestTransport(request("auto"), "personal", desktop)).toBe("shared");
    expect(browserRequestTransport(request("auto"), "personal", { ...desktop, personalTurnsAllowed: true })).toBe("personal");
    // Nothing else can open it: the card says why.
    expect(browserRequestTransport(request("auto"), "personal", { ...desktop, sharedUnavailable: true })).toBe("personal");
    expect(browserRequestUnavailableReason(request("auto"), { transport: "personal", ...desktop, sharedUnavailable: true }))
      .toBe("The browser on this device needs your own AI connection.");
    expect(browserRequestUnavailableReason(request("device"), { transport: "personal", ...desktop }))
      .toBe("The browser on this device needs your own AI connection.");
  });
});

describe("continuations of a card", () => {
  const jobCard = { ...card({ task: "Open x", location: "auto" }, "card-1"), metadata: { messageType: "action_request", jobId: "job-1", details: {} } };

  it("names a card by the job that sent it, which outlasts its message id", () => {
    expect(browserRequestKey(jobCard)).toBe("job:job-1");
    expect(browserRequestKey(card({ task: "Open x", location: "auto" }, "card-2"))).toBe("message:card-2");
  });

  it("reads the card a prompt continued from its own or its stored prompt metadata", () => {
    const local = { id: "p1", role: "user" as const, content: "Octo opened Instafy's browser", timestamp: 3,
      metadata: { browserRequestOf: "job:job-1" } };
    const stored = { ...local, id: "p2", metadata: { prompt_metadata: { browserRequestOf: "job:job-2" } } };
    expect(readBrowserRequestOf(local)).toBe("job:job-1");
    expect(readBrowserRequestOf(stored)).toBe("job:job-2");
    expect(readBrowserRequestOf({ ...local, role: "assistant" })).toBeNull();
    expect([...browserRequestContinuedKeys([jobCard, local, stored])]).toEqual(["job:job-1", "job:job-2"]);
  });

  it("tells a browser turn's prompt from an ordinary one", () => {
    expect(isBrowserTurnPromptMetadata({ browserTransport: "shared" })).toBe(true);
    expect(isBrowserTurnPromptMetadata({ prompt_metadata: { browserRequestOf: "job:job-1" } })).toBe(true);
    expect(isBrowserTurnPromptMetadata({ clientMessageId: "c1" })).toBe(false);
    expect(isBrowserTurnPromptMetadata(null)).toBe(false);
  });

  it("records a continuation as a one-line notice naming the agent and the host, without em dashes", () => {
    expect(browserRequestNotice("Octo", "Open https://dashboard.stripe.com/apikeys and stop on the list."))
      .toBe("Octo opened Instafy's browser at dashboard.stripe.com");
    expect(browserRequestNotice("", "Continue comparing the saved items.")).toBe("Octo opened Instafy's browser");
    expect(browserRequestNotice("Cub", "Open https://a.example")).not.toMatch(/\u2014/);
  });
});
