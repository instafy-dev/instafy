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
    title: "Continue in browser",
    description: "Open your browser and let the AI continue this task there.",
    browserRequest,
    actions: [{ id: "continue-browser", label: "Open browser and continue", variant: "primary",
      event: "instafy:request-browser", busyLabel: "Opening browser…", testId: "browser-request-continue" }],
  };
  return {
    message: { id: "card", role: "assistant", content: "Continue this task in your browser.", timestamp: 1,
      metadata: { messageType: "action_request", details } },
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
    return {
      destination: container.querySelector('[data-testid="browser-request-destination"]')?.textContent ?? null,
      unavailable: container.querySelector('[data-testid="browser-request-unavailable"]')?.textContent ?? null,
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

  it("cannot be pressed where no browser can open, and says why", async () => {
    const press = vi.fn();
    window.addEventListener("instafy:request-browser", press);
    const card = await render({ task: "Open https://app.example.test", location: "auto", workspaceBrowser: false }, web);
    expect(card.unavailable).toBe("Instafy's browser is not available in this workspace.");
    expect(card.button?.disabled).toBe(true);
    await act(async () => card.button?.click());
    expect(press).not.toHaveBeenCalled();
    window.removeEventListener("instafy:request-browser", press);
  });

  it("stays pressable when the browser on this device can open it instead", async () => {
    const card = await render(
      { task: "Open https://app.example.test", location: "auto", workspaceBrowser: false },
      { ...web, personalAvailable: true },
    );
    expect(card.unavailable).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });

  it("keeps its old behaviour where Studio provides no browser information", async () => {
    const card = await render({ task: "Open https://app.example.test", location: "device", workspaceBrowser: false }, null);
    expect(card.destination).toBe("Opens app.example.test");
    expect(card.unavailable).toBeNull();
    expect(card.button?.disabled).toBe(false);
  });
});
