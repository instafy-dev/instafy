import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  BROWSER_CARD_SITES_METADATA_KEY,
  pressedBrowserCardSites,
  browserRequestContinuation,
  browserRequestContinuedKeys,
  browserRequestDestinations,
  browserRequestFromContinuationPrompt,
  browserRequestFromMessage,
  browserRequestKey,
  browserRequestNotice,
  browserRequestTransport,
  browserRequestUnavailableReason,
  isBrowserTurnPromptMetadata,
  newestBrowserRequestKey,
  readBrowserRequestOf,
  type BrowserRequest,
} from "../browserRequest";

// What a card's browser turn sends is the controller's fixture too: it stamps
// such a send as the card's own browser turn, which costs nothing unless it
// does something in the browser, only when its words are exactly these
// (runtime-controller system_turns.rs).
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../../..");
const systemTurnFixtures = JSON.parse(readFileSync(
  resolve(repo, "packages/runtime-controller/src/system_turns_fixtures.json"), "utf8",
)) as { browserCardContinuationPrefix: string };

describe("browserRequestContinuation", () => {
  it("sends the card's task after the prefix the controller checks for, and nothing else", () => {
    const task = "Open https://app.example.test and find the opening hours.";
    expect(browserRequestContinuation({ task, location: "auto" }))
      .toBe(`${systemTurnFixtures.browserCardContinuationPrefix}${task}`);
  });
});

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

  it("reads whether Octo builds from what the browser finds, and only a plain true", () => {
    expect(browserRequestFromMessage(card({ task: "Open x", location: "auto", continueBuilding: true })))
      .toEqual({ task: "Open x", location: "auto", continueBuilding: true });
    for (const continueBuilding of [false, "true", 1, null]) {
      expect(browserRequestFromMessage(card({ task: "Open x", location: "auto", continueBuilding })))
        .toEqual({ task: "Open x", location: "auto" });
    }
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

  it("finds the newest card", () => {
    const older = card({ task: "Open x", location: "auto" }, "card-1");
    const olderJobCard = { ...older, metadata: { ...older.metadata, jobId: "job-1" } };
    const newer = card({ task: "Open y", location: "auto" }, "card-2");
    const reply = { id: "r", role: "assistant" as const, content: "Done.", timestamp: 4 };
    expect(newestBrowserRequestKey([olderJobCard, newer, reply])).toBe("message:card-2");
    expect(newestBrowserRequestKey([olderJobCard, reply, jobCard])).toBe("job:job-1");
    expect(newestBrowserRequestKey([reply])).toBeNull();
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

  // Local drive, Oct 28: "Octo opened Instafy's browser" after the person's
  // own press. Octo is named only when Studio opened it by itself.
  it("records a continuation as a one-line notice naming the host, and Octo only when it opened by itself", () => {
    expect(browserRequestNotice("Octo", "Open https://dashboard.stripe.com/apikeys and stop on the list."))
      .toBe("Opened Instafy's browser for dashboard.stripe.com");
    expect(browserRequestNotice("Octo", "Continue comparing the saved items.")).toBe("Opened Instafy's browser");
    expect(browserRequestNotice("Octo", "Open https://dashboard.stripe.com/apikeys", { automatic: true }))
      .toBe("Octo opened Instafy's browser for dashboard.stripe.com");
    expect(browserRequestNotice("", "Continue comparing the saved items.", { automatic: true }))
      .toBe("Octo opened Instafy's browser");
    expect(browserRequestNotice("Cub", "Open https://a.example", { automatic: true })).not.toMatch(/\u2014/);
  });
});

describe("browserRequestFromContinuationPrompt", () => {
  const continuation = (metadata: Record<string, unknown>): ChatMessage => ({ id: "p1", role: "user", timestamp: 3,
    content: "Octo opened Instafy's browser for app.example.test", metadata });
  const dispatched = browserRequestContinuation({ task: "Open https://app.example.test and stop on API keys.", location: "auto" });

  it("reads the task a continuation sent, and the browser it ran in, never the notice", () => {
    expect(browserRequestFromContinuationPrompt(continuation({
      prompt_metadata: { browserRequestOf: "job:job-1", dispatchContent: dispatched, browserTransport: "shared" },
    }))).toEqual({ task: "Open https://app.example.test and stop on API keys.", location: "workspace" });
    expect(browserRequestFromContinuationPrompt(continuation({
      browserRequestOf: "job:job-1", dispatchContent: dispatched, browserTransport: "desktop-personal",
    }))).toEqual({ task: "Open https://app.example.test and stop on API keys.", location: "device" });
    // A retry of a card Octo builds from still hands back.
    expect(browserRequestFromContinuationPrompt(continuation({
      prompt_metadata: { browserRequestOf: "job:job-1", dispatchContent: dispatched, browserTransport: "shared",
        browserHandsBack: true },
    }))).toEqual({ task: "Open https://app.example.test and stop on API keys.", location: "workspace", continueBuilding: true });
  });

  it("finds nothing for an ordinary prompt or one without the task", () => {
    expect(browserRequestFromContinuationPrompt(continuation({ dispatchContent: dispatched }))).toBeNull();
    expect(browserRequestFromContinuationPrompt(continuation({ browserRequestOf: "job:job-1" }))).toBeNull();
    expect(browserRequestFromContinuationPrompt(continuation({
      browserRequestOf: "job:job-1", dispatchContent: "Octo opened Instafy's browser for app.example.test",
    }))).toBeNull();
  });
});

describe("pressedBrowserCardSites", () => {
  const continuation = (id: string, task: string, extra: Record<string, unknown> = {}, authorId = "user-1"): ChatMessage => ({
    id, role: "user", authorId, timestamp: 3, content: "Octo opened Instafy's browser",
    metadata: { prompt_metadata: {
      browserRequestOf: `job:${id}`, dispatchContent: browserRequestContinuation({ task, location: "workspace" }),
      browserTransport: "shared", ...extra,
    } },
  });

  it("names the sites of the cards the person pressed in the chat, for its later browser turns", () => {
    // Drive, Oct 28: the follow-up asked for www.visitlisboa.com again, the
    // site of the card pressed four minutes earlier in the same chat.
    expect(pressedBrowserCardSites([
      continuation("a", "Open https://www.visitlisboa.com and find Belém Tower's opening hours."),
      { id: "o", role: "user", timestamp: 4, content: "Now find how to get there by tram.", metadata: {} },
      continuation("b", "Open https://www.carris.pt/en/ and https://www.visitlisboa.com/en."),
    ], "user-1")).toEqual(["www.carris.pt", "www.visitlisboa.com"]);
  });

  it("counts only the person's own presses, never a teammate's in the same chat", () => {
    const chat = [
      continuation("a", "Open https://www.visitlisboa.com and find Belém Tower's opening hours.", {}, "user-2"),
      continuation("b", "Open https://www.carris.pt/en/ and read the 15E route.", {}, "user-1"),
    ];
    expect(pressedBrowserCardSites(chat, "user-1")).toEqual(["www.carris.pt"]);
    expect(pressedBrowserCardSites(chat, "user-2")).toEqual(["www.visitlisboa.com"]);
    expect(pressedBrowserCardSites(chat, null)).toEqual([]);
  });

  it("never counts a card Studio opened by itself, or a task that names no site", () => {
    expect(pressedBrowserCardSites([
      continuation("a", "Open https://auto.example.test and read it.", { browserAutoStarted: true }),
      continuation("b", "Research the three latest robot vacuums and compare them."),
    ], "user-1")).toEqual([]);
  });

  it("keeps the key the runtime reads", () => {
    expect(BROWSER_CARD_SITES_METADATA_KEY).toBe("browserCardSites");
  });
});
