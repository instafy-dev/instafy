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
      opening: text("browser-request-opening"),
      openingNote: text("browser-request-opening-note"),
      opened: text("browser-request-opened"),
      notOpened: text("browser-request-not-opened"),
      reason: text("browser-request-reason"),
      button: container.querySelector<HTMLButtonElement>('[data-testid="browser-request-continue"]'),
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

  // Octo opens Instafy's browser by itself (owner decision, Oct 19); the card
  // says so in place of its button, or keeps the button with the reason.
  const task = { task: "Open https://dashboard.stripe.com/apikeys and stop on the list.", location: "auto" };

  it("reads Opening while Studio opens the browser by itself, with the cost of switching the machine", async () => {
    const card = await render(task, { ...web, cardStates: new Map([["job:job-1", {
      kind: "opening", note: "This space's machine restarts with the browser. This takes about two minutes and one billing interval.",
    }]]) });
    expect(card.opening).toBe("Opening Instafy's browser for dashboard.stripe.com");
    expect(card.openingNote).toContain("about two minutes and one billing interval");
    expect(card.button).toBeNull();
    expect(card.destination).toBeNull();
  });

  it("reads a plain Opened, without its button, once continued, also after a reload", async () => {
    for (const host of [
      { ...web, cardStates: new Map([["job:job-1", { kind: "opened" } as const]]) },
      { ...web, continuedKeys: new Set(["job:job-1"]) },
      // Also once a newer card followed it.
      { ...web, continuedKeys: new Set(["job:job-1"]), newestCardKey: "job:job-2" },
    ]) {
      const card = await render(task, host);
      // The browser opened; whether the site loaded is for the browser to show.
      expect(card.opened).toBe("Opened");
      expect(card.button).toBeNull();
      expect(card.destination).toBeNull();
    }
  });

  // Local drive, Oct 28: two live cards stacked up in one chat, and the older
  // one's button stayed pressable for the rest of it.
  it("offers no button once a newer card followed it, and the newest keeps its own", async () => {
    let card = await render(task, { ...web, newestCardKey: "job:job-2" });
    expect(card.button).toBeNull();
    expect(card.destination).toBeNull();
    expect(card.opened).toBeNull();
    // It never opened, and it no longer promises to: a plain "Not opened".
    expect(card.notOpened).toBe("Not opened");
    expect(container.textContent).not.toContain("Studio opens the browser");
    card = await render(task, { ...web, newestCardKey: "job:job-1" });
    expect(card.button?.disabled).toBe(false);
    expect(card.destination).toBe("For dashboard.stripe.com");
    expect(card.notOpened).toBeNull();
    // No reason or warning on a card that offers nothing to press.
    card = await render(task, { ...web, sharedUnavailable: true, newestCardKey: "job:job-2", cardStates: new Map([[
      "job:job-1", { kind: "button", reason: "This starts a second cloud machine for this space." } as const,
    ]]) });
    expect(card.button).toBeNull();
    expect(card.reason).toBeNull();
    expect(card.unavailable).toBeNull();
  });

  // Local drive, Oct 29: every card said "Studio opens the browser and
  // continues this task there.", whether it opened by itself or waited for a
  // press. The card says what it is for; Opening and Opened say the rest.
  it("never says what Studio does, as a button, while opening or once opened, an older card included", async () => {
    for (const host of [
      web,
      { ...web, cardStates: new Map([["job:job-1", { kind: "opening", note: null } as const]]) },
      { ...web, continuedKeys: new Set(["job:job-1"]) },
    ]) {
      await render(task, host);
      expect(container.textContent).toContain("Continue in Instafy's browser");
      expect(container.textContent).not.toContain("Studio opens the browser");
    }
    const opening = await render(task, { ...web, cardStates: new Map([["job:job-1", { kind: "opening", note: null } as const]]) });
    expect(opening.opening).toBe("Opening Instafy's browser for dashboard.stripe.com");
  });

  it("keeps the button with the reason Studio did not open it by itself", async () => {
    const card = await render(task, { ...web, cardStates: new Map([["job:job-1", {
      kind: "button", reason: "This starts a second cloud machine for this space.",
    } as const]]) });
    expect(card.reason).toBe("This starts a second cloud machine for this space.");
    expect(card.destination).toBe("For dashboard.stripe.com");
    expect(card.button?.disabled).toBe(false);
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
});
