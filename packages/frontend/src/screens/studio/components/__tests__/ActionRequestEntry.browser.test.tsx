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
      reason: text("browser-request-reason"),
      button: container.querySelector<HTMLButtonElement>('[data-testid="browser-request-continue"]'),
    };
  }

  const web: BrowserRequestHost = { transport: "shared", personalAvailable: false, sharedUnavailable: false };

  it("names the host its press opens", async () => {
    const card = await render({ task: "Open https://app.freefinance.at/login and take me to Verbundene Apps.", location: "auto" }, web);
    expect(card.destination).toBe("Opens app.freefinance.at");
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
    expect(card.opening).toBe("Opening Instafy's browser at dashboard.stripe.com");
    expect(card.openingNote).toContain("about two minutes and one billing interval");
    expect(card.button).toBeNull();
    expect(card.destination).toBeNull();
  });

  it("reads Opened, without its button, once continued, also after a reload", async () => {
    for (const host of [
      { ...web, cardStates: new Map([["job:job-1", { kind: "opened" } as const]]) },
      { ...web, continuedKeys: new Set(["job:job-1"]) },
    ]) {
      const card = await render(task, host);
      expect(card.opened).toContain("Opened");
      expect(card.opened).toContain("dashboard.stripe.com");
      expect(card.button).toBeNull();
    }
  });

  it("keeps the button with the reason Studio did not open it by itself", async () => {
    const card = await render(task, { ...web, cardStates: new Map([["job:job-1", {
      kind: "button", reason: "This starts a second cloud machine for this space.",
    } as const]]) });
    expect(card.reason).toBe("This starts a second cloud machine for this space.");
    expect(card.destination).toBe("Opens dashboard.stripe.com");
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
    expect(card.destination).toBe("Opens app.example.test");
    expect(card.unavailable).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });
});
