/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { ActionRequestEntry } from "../ActionRequestEntry";
import { BrowserRequestHostContext, type BrowserRequestHost } from "../browserRequest";

// The card the runtime sends for request_browser (browser_request.rs).
function browserCard(browserRequest: Record<string, unknown>): { message: ChatMessage; details: Record<string, unknown> } {
  const details = {
    testId: "browser-request-card",
    title: "Continue in Instafy's browser",
    description: "Studio opens the browser and continues this task there.",
    browserRequest,
    actions: [{ id: "continue-browser", label: "Open browser and continue", variant: "primary",
      event: "instafy:request-browser", busyLabel: "Opening browser…", testId: "browser-request-continue" }],
  };
  return {
    message: { id: "card", role: "assistant", content: "Continue this task in Instafy's browser.", timestamp: 1,
      metadata: { messageType: "action_request", jobId: "job-1", details } },
    details,
  };
}

describe("a request_browser card", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(browserRequest: Record<string, unknown>, host: BrowserRequestHost | null) {
    const { message, details } = browserCard(browserRequest);
    await act(async () => {
      root.render(
        <BrowserRequestHostContext.Provider value={host}>
          <ActionRequestEntry message={message} details={details} />
        </BrowserRequestHostContext.Provider>,
      );
    });
    const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    return {
      destination: text("browser-request-destination"),
      unavailable: text("browser-request-unavailable"),
      openingNote: text("browser-request-opening-note"),
      reason: text("browser-request-reason"),
      button: container.querySelector<HTMLButtonElement>('[data-testid="browser-request-continue"]'),
      // The turn's one line while Studio opens the browser for the card.
      line: text("browser-request-opening"),
      card: container.querySelector('[data-testid="browser-request-card"]'),
      // Whatever the chat shows for it: nothing once it has left the chat.
      shown: container.innerHTML,
    };
  }

  const web: BrowserRequestHost = { transport: "shared", personalAvailable: false, sharedUnavailable: false };

  // The host comes from the task's text, not from the page the browser
  // reached, so the card names it as where the task is headed, never as a
  // page that opened.
  it("names the host its task is headed for", async () => {
    const card = await render({ task: "Open https://app.freefinance.at/login and take me to Verbundene Apps.", location: "auto" }, web);
    expect(card.destination).toBe("For app.freefinance.at");
    expect(card.unavailable).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });

  it("says nothing about a destination its task does not give", async () => {
    const card = await render({ task: "Continue comparing the saved items.", location: "auto" }, web);
    expect(card.destination).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });

  it("can be pressed while Instafy's browser is not known to be unavailable", async () => {
    // A hosted space's Workspace browser starts on demand as a runtime of its
    // own, so the runtime that offered the card says nothing about it, and a
    // card from a runtime that once did (`workspaceBrowser: false`) is
    // pressable too.
    for (const browserRequest of [
      { task: "Open https://app.example.test", location: "auto" },
      { task: "Open https://app.example.test", location: "auto", workspaceBrowser: false },
    ]) {
      const card = await render(browserRequest, web);
      expect(card.unavailable).toBeNull();
      expect(card.button?.disabled).toBe(false);
    }
  });

  it("cannot be pressed where no browser can open, and says why", async () => {
    const press = vi.fn();
    window.addEventListener("instafy:request-browser", press);
    const card = await render({ task: "Open https://app.example.test", location: "auto" }, { ...web, sharedUnavailable: true });
    expect(card.unavailable).toBe("Instafy's browser is not available in this workspace.");
    expect(card.button?.disabled).toBe(true);
    await act(async () => card.button?.click());
    expect(press).not.toHaveBeenCalled();
    window.removeEventListener("instafy:request-browser", press);
  });

  it("stays pressable when the browser on this device can open it instead", async () => {
    const card = await render(
      { task: "Open https://app.example.test", location: "auto" },
      { ...web, sharedUnavailable: true, personalAvailable: true },
    );
    expect(card.unavailable).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });

  // Octo opens Instafy's browser by itself (owner decision, Oct 19). A card
  // shows only while it needs the person; while Studio opens it, it reads as
  // the turn's one line.
  const task = { task: "Open https://dashboard.stripe.com/apikeys and stop on the list.", location: "auto" };

  it("reads as the turn's one line while Studio opens the browser by itself, with the cost of switching the machine", async () => {
    const card = await render(task, { ...web, cardStates: new Map([["job:job-1", {
      kind: "opening", note: "This space's machine restarts with the browser. This takes about two minutes and one billing interval.",
    }]]) });
    expect(card.line).toContain("Opening Instafy's browser…");
    expect(card.openingNote).toContain("about two minutes and one billing interval");
    // No box: no card, no button, no site.
    expect(card.card).toBeNull();
    expect(card.button).toBeNull();
    expect(card.destination).toBeNull();
  });

  // Local test, Nov 2: once Studio opened the browser for a map turn's card,
  // the card stayed as a full card saying only "Opened", above the reply,
  // with "Octo opened Instafy's browser" right under it. The continuation's
  // one line and the browser turn's own line are the record.
  it("leaves the chat once Instafy's browser opened for it, by Studio or by a press, also after a reload", async () => {
    for (const host of [
      // Studio opened it by itself, or the person pressed it, here.
      { ...web, cardStates: new Map([["job:job-1", { kind: "opened" } as const]]) },
      { ...web, cardStates: new Map([["job:job-1", { kind: "opening", note: null } as const]]), continuedKeys: new Set(["job:job-1"]) },
      // After a reload, or on another device: its continuation is in the chat.
      { ...web, continuedKeys: new Set(["job:job-1"]) },
      { ...web, continuedKeys: new Set(["job:job-1"]), newestCardKey: "job:job-1" },
      { ...web, continuedKeys: new Set(["job:job-1"]), newestCardKey: "job:job-2" },
    ]) {
      const card = await render(task, host);
      expect(card.shown).toBe("");
    }
  });

  // Local drive, Oct 28: two live cards stacked up in one chat, and the older
  // one's button stayed pressable for the rest of it.
  it("leaves the chat once a newer card followed it, and the newest keeps its button", async () => {
    let card = await render(task, { ...web, newestCardKey: "job:job-2" });
    expect(card.shown).toBe("");
    // Whatever it said before: a reason, or that no browser opens here.
    card = await render(task, { ...web, sharedUnavailable: true, newestCardKey: "job:job-2", cardStates: new Map([[
      "job:job-1", { kind: "button", reason: "This starts a second cloud machine for this space." } as const,
    ]]) });
    expect(card.shown).toBe("");
    card = await render(task, { ...web, newestCardKey: "job:job-1" });
    expect(card.button?.disabled).toBe(false);
    expect(card.destination).toBe("For dashboard.stripe.com");
  });

  // Local drive, Oct 29: every card said "Studio opens the browser and
  // continues this task there.", whether it opened by itself or waited for a
  // press. The card says what it is for; the line says the rest.
  it("never says what Studio does, as a button or while opening", async () => {
    for (const host of [web, { ...web, cardStates: new Map([["job:job-1", { kind: "opening", note: null } as const]]) }]) {
      await render(task, host);
      expect(container.textContent).not.toContain("Studio opens the browser");
    }
    await render(task, web);
    expect(container.textContent).toContain("Continue in Instafy's browser");
  });

  // Studio could not open it by itself: the card stays, with its button, the
  // site it is for and why, until the person's press opened the browser.
  it("keeps the button with the reason Studio did not open it by itself, until the press opened the browser", async () => {
    const reason = { kind: "button", reason: "This starts a second cloud machine for this space." } as const;
    let card = await render(task, { ...web, cardStates: new Map([["job:job-1", reason]]) });
    expect(card.reason).toBe("This starts a second cloud machine for this space.");
    expect(card.destination).toBe("For dashboard.stripe.com");
    expect(card.button?.disabled).toBe(false);
    // Opening failed: the button comes back with why.
    card = await render(task, { ...web, cardStates: new Map([["job:job-1", {
      kind: "button", reason: "Instafy's browser could not open. See the browser for details, then try again.",
    } as const]]) });
    expect(card.reason).toBe("Instafy's browser could not open. See the browser for details, then try again.");
    expect(card.button?.disabled).toBe(false);
    // The press went out.
    card = await render(task, { ...web, cardStates: new Map([["job:job-1", { kind: "opened" } as const]]),
      continuedKeys: new Set(["job:job-1"]) });
    expect(card.shown).toBe("");
  });

  it("says the browser on this device needs the person's own AI", async () => {
    const card = await render({ ...task, location: "device" }, {
      transport: "personal", personalAvailable: true, sharedUnavailable: false, personalTurnsAllowed: false,
    });
    expect(card.unavailable).toBe("The browser on this device needs your own AI connection.");
    expect(card.button?.disabled).toBe(true);
  });

  it("keeps its old behaviour where Studio provides no browser information", async () => {
    const card = await render({ task: "Open https://app.example.test", location: "device" }, null);
    expect(card.destination).toBe("For app.example.test");
    expect(card.unavailable).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });

  // A message Octo sent straight to the browser: while Studio opens its card
  // by itself, the turn's one line says so, and no card shows. One Studio
  // could not open by itself shows as any card does, with its reason.
  describe("sent straight to the browser", () => {
    const routed = { task: "Open https://forms.example/order in your browser and fill in a test order.", location: "auto", routed: true };

    it("reads as the turn's one line while Studio opens it, and until its browser turn shows something", async () => {
      for (const host of [
        { ...web, cardStates: new Map([["job:job-1", { kind: "opening", note: null } as const]]) },
        { ...web, cardStates: new Map([["job:job-1", { kind: "opened" } as const]]),
          continuedKeys: new Set(["job:job-1"]), routedWaitingKeys: new Set(["job:job-1"]) },
        { ...web, continuedKeys: new Set(["job:job-1"]), routedWaitingKeys: new Set(["job:job-1"]) },
      ]) {
        const card = await render(routed, host);
        expect(card.line).toBe("Opening Instafy's browser…");
        expect(card.card).toBeNull();
        expect(card.button).toBeNull();
      }
      const slow = await render(routed, { ...web, cardStates: new Map([["job:job-1", {
        kind: "opening", note: "This space's machine restarts with the browser. This takes about two minutes and one billing interval.",
      }]]) });
      expect(slow.openingNote).toContain("about two minutes and one billing interval");
    });

    // Pressed by the person (here or on another device), or carried on by a
    // browser turn that failed or was stopped before it showed anything: no
    // browser is opening, so it never says one is, and it leaves the chat as
    // any card does.
    it("leaves the chat as any card does once nothing is opening it any more", async () => {
      for (const host of [
        { ...web, continuedKeys: new Set(["job:job-1"]) },
        { ...web, cardStates: new Map([["job:job-1", { kind: "opened" } as const]]), continuedKeys: new Set(["job:job-1"]) },
      ]) {
        const card = await render(routed, host);
        expect(card.shown).toBe("");
      }
    });

    it("stays today's card, with its reason, when Studio could not open it by itself", async () => {
      const held = await render(routed, { ...web, cardStates: new Map([["job:job-1", {
        kind: "button", reason: "Someone else is using Instafy's browser right now.",
      }]]) });
      expect(held.line).toBeNull();
      expect(held.card).not.toBeNull();
      expect(held.reason).toBe("Someone else is using Instafy's browser right now.");
      expect(held.button?.disabled).toBe(false);
      const unavailable = await render(routed, { ...web, sharedUnavailable: true });
      expect(unavailable.line).toBeNull();
      expect(unavailable.unavailable).toBe("Instafy's browser is not available in this workspace.");
    });

    // Only a routed card waits for its browser turn to show something: any
    // other card's continuation leaves its own one line in the chat.
    it("keeps the line until the browser turn shows something only for a card the routing step sent", async () => {
      const waiting = { ...web, continuedKeys: new Set(["job:job-1"]), routedWaitingKeys: new Set(["job:job-1"]) };
      expect((await render(routed, waiting)).line).toBe("Opening Instafy's browser…");
      expect((await render({ task: routed.task, location: "auto" }, waiting)).shown).toBe("");
      const opening = await render({ task: routed.task, location: "auto" }, { ...web, cardStates: new Map([["job:job-1", { kind: "opening", note: null } as const]]) });
      expect(opening.line).toBe("Opening Instafy's browser…");
      expect(opening.card).toBeNull();
    });
  });
});
