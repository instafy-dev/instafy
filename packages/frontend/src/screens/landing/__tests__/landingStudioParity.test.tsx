// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeBrowserSessionAction } from "../../../services/runtimeController/browserSession";
import { ActionTicker } from "../../studio/components/ActionTicker";
import { browserRequestContinuation } from "../../studio/components/browserRequest";
import { RemoteControlSurface } from "../../studio/components/RemoteControlSurface";
import { SharedBrowserApprovalPrompt, type SharedBrowserApprovalPromptRequest } from "../../studio/components/SharedBrowserApprovalPrompt";
import { LandingBrowserView } from "../LandingBrowserView";
import { paneStateFor } from "../landingPanes";
import * as chrome from "../landingStudioChrome";
import { SESSION_SCENARIOS, beatIndex, browserContinuation, type TurnBeatId } from "../landingTurnScript";

// The landing draws the Shared Browser's ticker, edge glow and site approval
// as presentational replicas: the studio's own components announce themselves
// (aria-live, role="status") and take focus (the prompt focuses Deny), and
// nothing in the landing's window may. These checks render the studio's
// components beside the replicas, so a wording or styling change in the studio
// fails here instead of drifting silently from the landing.

const site = SESSION_SCENARIOS[2];
const script = site.browser!;
const tokens = (className: string | null | undefined) => new Set((className ?? "").split(/\s+/).filter(Boolean));
const text = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the landing's browser replicas match the studio's components", () => {
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

  async function render(node: React.ReactNode) {
    await act(async () => root.render(<>{node}</>));
  }

  async function landingAt(id: TurnBeatId) {
    const pane = paneStateFor(site, beatIndex(site, id));
    await render(<LandingBrowserView stage={pane.browser!} script={script} playing />);
    return container.querySelector('[data-testid="landing-browser-dock"]') as HTMLElement;
  }

  it("captions each action like ActionTicker: its overlay, pill and dot colours", async () => {
    const beats: TurnBeatId[] = ["navigate", "loaded", "scroll", "click"];
    for (const [seq, id] of beats.entries()) {
      const landing = await landingAt(id);
      const pill = landing.querySelector('[data-testid="landing-browser-ticker"]') as HTMLElement;
      const ticker = paneStateFor(site, beatIndex(site, id)).browser!.ticker!;
      const landingOverlay = tokens(pill.parentElement?.className);
      const landingPill = tokens(pill.className);
      const landingDot = tokens(pill.firstElementChild?.className);
      const caption = text(pill);

      const action: RuntimeBrowserSessionAction = {
        seq,
        ts: seq,
        type: ticker.type,
        label: ticker.label,
        url: script.url,
        x: null,
        y: null,
        viewportW: null,
        viewportH: null,
      };
      await render(<ActionTicker actions={[action]} />);
      const studio = container.querySelector('[data-testid="browser-action-ticker"]') as HTMLElement;
      const studioPill = studio.firstElementChild as HTMLElement;
      expect(landingOverlay).toEqual(tokens(studio.className));
      // The studio's pill adds only its fade (transition and the visible state).
      for (const token of landingPill) expect(studioPill.classList.contains(token)).toBe(true);
      expect(landingDot).toEqual(tokens(studioPill.firstElementChild?.className));
      expect(caption).toBe(text(studioPill));
    }
  });

  it("draws the edge glow with RemoteControlSurface's own markup while Octo works", async () => {
    const landing = await landingAt("navigate");
    const glow = landing.querySelector('[data-testid="landing-browser-glow"] .browser-agent-surface') as HTMLElement;
    await render(<RemoteControlSurface controller="Octo" working />);
    const studio = container.querySelector('[data-testid="browser-agent-surface"]') as HTMLElement;
    expect(glow.dataset.working).toBe(studio.dataset.working);
    expect(tokens(glow.className)).toEqual(tokens(studio.className));
    expect(tokens(glow.firstElementChild?.className)).toEqual(tokens(studio.querySelector(".browser-agent-glow")?.className));
  });

  it("asks for the site in SharedBrowserApprovalPrompt's own words", async () => {
    const request: SharedBrowserApprovalPromptRequest = {
      approvalId: "11111111-1111-4111-8111-111111111111",
      kind: "origin",
      operation: "approve-origin",
      sourceOrigin: null,
      destinationOrigin: script.origin,
      expiresAtMs: Date.now() + 30_000,
      display: { label: "", destinationOrigin: script.origin },
    };
    const landing = await landingAt("approve");
    const sheet = landing.querySelector('[data-testid="landing-browser-approval"]') as HTMLElement;
    const landingText = text(sheet);
    const landingContent = tokens(sheet.firstElementChild?.firstElementChild?.className);

    await render(<SharedBrowserApprovalPrompt active={false} request={request} submitting={false} error={null} onDecision={() => {}} />);
    const studio = container.querySelector('[data-testid="shared-browser-approval-scrim"]') as HTMLElement;
    expect(landingText).toBe(text(studio));
    expect(text(container.querySelector('[data-testid="shared-browser-approval-allow"]'))).toBe("Allow site");
    // The scrim and the content keep the studio's classes, bar the swaps
    // the chrome documents (dark tiers; nothing scrolls by hand, so neither
    // holds a tab stop).
    const scrim = tokens(chrome.APPROVAL_SCRIM);
    for (const token of tokens(studio.className)) if (token !== "overflow-y-auto") expect(scrim.has(token)).toBe(true);
    const content = container.querySelector('[data-testid="shared-browser-approval-content"]') as HTMLElement;
    for (const token of tokens(content.className)) if (token !== "overflow-y-auto") expect(landingContent.has(token)).toBe(true);
  });

  it("sends Ada's continuation as browserRequestContinuation words it", () => {
    expect(browserContinuation(script.task)).toBe(browserRequestContinuation({ task: script.task, location: "workspace" }));
  });
});
