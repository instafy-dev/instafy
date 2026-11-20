// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHumanInputControls, humanInputGuidance } from "../BrowserHumanInputControls";
import { SharedBrowserCollaborationControls } from "../SharedBrowserCollaborationControls";
import { BROWSER_HUMAN_INPUT_CONTINUE_PROMPT } from "../useBrowserHumanInput";

describe("BrowserHumanInputControls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof BrowserHumanInputControls>;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    props = { identityKey: "user/project/conversation/shared/runtime/page", request: null, canTakeOver: true,
      humanControlConfirmed: false, onTakeOver: vi.fn(async () => true), onContinue: vi.fn(async () => true) };
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const render = async () => { await act(async () => root.render(<BrowserHumanInputControls {...props} />)); };
  const click = async (testId: string) => {
    if (testId === "browser-human-input-takeover" && !document.querySelector('[data-testid="browser-human-input-takeover"]')) {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-request"]')!.click());
    }
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
  };

  const compactControls: NonNullable<ComponentProps<typeof BrowserHumanInputControls>["renderControls"]> = (controls) => (
    <SharedBrowserCollaborationControls compact localControlOwner={{ kind: "agent", displayName: "Octo" }}
      client={{ connectionStatus: "connected", participantId: "self", error: null, state: {
        revision: 1, controlOwner: { kind: "agent", displayName: "Octo" }, requests: [],
        participants: [{ id: "self", displayName: "Taylor", color: "#0ea5e9", canControl: true, pageId: "page", cursor: null }],
      } }} onGrantControl={vi.fn()} onReleaseControl={vi.fn()} onRequestControl={vi.fn()} onTakeControl={vi.fn()}>
      {controls}
    </SharedBrowserCollaborationControls>
  );
  const finishFocusRestoration = async () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

  it("names Octo in the take-over dialog", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-request"]')!.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="Take over browser"]')!;
    expect(dialog.textContent).toContain("Octo will pause so you can use the page.");
    expect(dialog.textContent).toContain("Let Octo continue");
    expect(dialog.textContent).toContain("Keep Octo working");
    expect(dialog.textContent).not.toContain("AI");
  });

  it("keeps a surface-triggered takeover dialog available while compact controls are closed", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    props.renderControls = compactControls;
    await render();
    const presence = container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-collaboration-toggle"]')!;
    expect(presence).not.toBeNull();
    expect(document.querySelector('[data-testid="browser-human-input-request"]')).toBeNull();
    await act(async () => presence.focus());
    props.takeoverRequestId = "native-page-click";
    await render();
    expect(presence.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"][aria-label="Take over browser"]')).not.toBeNull();
    expect(props.onTakeOver).not.toHaveBeenCalled();
    await click("browser-human-input-cancel");
    await finishFocusRestoration();
    await finishFocusRestoration();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(presence);
    expect(props.onTakeOver).not.toHaveBeenCalled();
  });

  it("can take over through compact controls and continue from the same menu", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    props.renderControls = compactControls;
    await render();
    await click("shared-browser-collaboration-toggle");
    await click("browser-human-input-request");
    expect(document.querySelector('[role="dialog"][aria-label="Take over browser"]')).not.toBeNull();
    await click("browser-human-input-takeover");
    expect(props.onTakeOver).toHaveBeenCalledOnce();
    props.humanControlConfirmed = true;
    await render();
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
  });

  it("hands the browser back with words that are true whether or not the person used it", () => {
    // Let Octo continue also follows a take-over where the person only watched.
    expect(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT).not.toMatch(/\bI have finished\b|\bI entered\b/);
    expect(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT).toMatch(/^Continue the previous browser task on this same page\./);
    expect(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT).toMatch(/Take a fresh snapshot before acting/);
    expect(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT).toMatch(/do not reuse old target indices or request, reveal, or repeat any values/);
  });

  it("keeps the collaboration menu available when there are no human-input actions", async () => {
    props.canTakeOver = false;
    props.renderControls = compactControls;
    await render();
    expect(container.querySelector('[data-testid="shared-browser-collaboration-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser-human-input-controls"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("asks before taking over and leaves control untouched when dismissed", async () => {
    await render();
    expect(container.textContent).not.toContain("Need to fill something yourself");
    await click("browser-human-input-request");
    expect(document.querySelector('[role="dialog"][aria-label="Take over browser"]')).not.toBeNull();
    expect(props.onTakeOver).not.toHaveBeenCalled();
    await click("browser-human-input-cancel");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(props.onTakeOver).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="browser-human-input-continue"]')).toBeNull();
  });

  it("handles each native click once and discards a popup when its browser changes", async () => {
    props.takeoverRequestId = "native-click-1";
    await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click("browser-human-input-cancel");
    props.canTakeOver = false; await render();
    props.canTakeOver = true; await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    props.takeoverRequestId = "native-click-2"; await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    props = { ...props, identityKey: "replacement-browser", takeoverRequestId: undefined }; await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(props.onTakeOver).not.toHaveBeenCalled();
  });

  it("supports manual takeover without an AI request and waits for authoritative ownership", async () => {
    await render(); await click("browser-human-input-takeover");
    expect(props.onTakeOver).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Waiting for agent control");
    expect(container.querySelector('[data-testid="browser-human-input-continue"]')).toBeNull();
    props.humanControlConfirmed = true; await render();
    expect(container.textContent).toContain("You control");
    expect(props.onContinue).not.toHaveBeenCalled();
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
    expect(container.textContent).not.toContain("Let Octo continue");
  });

  it("does not continue automatically or duplicate an in-flight explicit continuation", async () => {
    let finish!: (sent: boolean) => void;
    props.request = { version: 1, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props.humanControlConfirmed = true;
    props.onContinue = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await render(); expect(props.onContinue).not.toHaveBeenCalled();
    await click("browser-human-input-continue"); await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    props.humanControlConfirmed = false; await render();
    expect(container.textContent).toContain("Continuing…");
    expect(container.textContent).not.toContain("Stopping Octo");
    expect(container.textContent).not.toContain("Waiting for agent control to stop");
    expect(container.querySelector('[data-testid="browser-human-input-continue"]')).toBeNull();
    props.humanControlConfirmed = true; await render();
    await act(async () => finish(false));
    expect(container.textContent).toContain("was not sent");
    expect(container.textContent).toContain("Let Octo continue");
  });

  // A local test, Nov 20: a Stop during a sign-in pause stopped the turn at
  // once, and 1.5 s later Let Octo continue turned on beside the chat's own
  // Continue under the stopped turn.
  it("ends a pause whose turn a Stop ended, and never offers Let Octo continue for it", async () => {
    const request = { version: 1 as const, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props = { ...props, request, canTakeOver: false, humanControlConfirmed: false };
    await render();
    // The pause waits while its turn ends.
    expect(container.querySelector('[role="status"].sr-only')?.textContent).toContain("Waiting for agent control to stop");
    // The Stop: the pause is over at once, before Octo has let go...
    props = { ...props, stoppedHandoffId: "handoff" };
    await render();
    expect(container.querySelector('[data-testid="browser-human-input-controls"]')).toBeNull();
    // ...and once it has, with the person holding the browser.
    props = { ...props, humanControlConfirmed: true };
    await render();
    expect(container.textContent).not.toContain("Let Octo continue");
    expect(container.textContent).not.toContain("highlighted field");
    expect(container.querySelector('[data-testid="browser-human-input-continue"]')).toBeNull();
    expect(props.onContinue).not.toHaveBeenCalled();
    // The pause stays over after its request has left the log, and after
    // the Stop's record has left the chat's latest messages.
    props = { ...props, request: null };
    await render();
    expect(container.textContent).not.toContain("Let Octo continue");
    props = { ...props, stoppedHandoffId: null };
    await render();
    expect(container.textContent).not.toContain("Let Octo continue");
  });

  // The Stop's record can come after the pause's request has gone: the
  // sign-in went on to another site, the request ran out, or the view was
  // behind Chat and read no log. The row the pause left is over all the same.
  it("ends a stopped pause that had outlasted its request", async () => {
    const request = { version: 1 as const, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props = { ...props, request, canTakeOver: false, humanControlConfirmed: true };
    await render();
    props = { ...props, request: null };
    await render();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')?.disabled).toBe(false);
    props = { ...props, stoppedHandoffId: "handoff" };
    await render();
    expect(container.querySelector('[data-testid="browser-human-input-continue"]')).toBeNull();
    expect(container.textContent).not.toContain("Let Octo continue");
    // Its request, read from the log again, brings nothing back.
    props = { ...props, request };
    await render();
    expect(container.querySelector('[data-testid="browser-human-input-continue"]')).toBeNull();
    expect(container.textContent).not.toContain("highlighted field");
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("keeps a pause through a take-over, which cancels its turn without a Stop", async () => {
    props.request = { version: 1, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props.stoppedHandoffId = null;
    await render();
    // They click into the page while the turn that paused still ends.
    props.takeoverRequestId = "page-click"; await render();
    await click("browser-human-input-takeover");
    expect(props.onTakeOver).toHaveBeenCalledOnce();
    props.canTakeOver = false; props.humanControlConfirmed = true; await render();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')!;
    expect(button.disabled).toBe(false);
    expect(button.title).toContain("Fill the highlighted field on the page");
  });

  it("offers Let Octo continue again after a take-over that follows a stopped pause", async () => {
    const request = { version: 1 as const, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props = { ...props, request, stoppedHandoffId: "handoff", canTakeOver: false, humanControlConfirmed: true };
    await render();
    expect(container.textContent).not.toContain("Let Octo continue");
    // A later turn drives, and the person takes over: that is theirs to
    // continue, as any take-over is; the stopped pause's guidance stays gone.
    props = { ...props, canTakeOver: true, humanControlConfirmed: false };
    await render(); await click("browser-human-input-takeover");
    props = { ...props, canTakeOver: false, humanControlConfirmed: true };
    await render();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')!;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("You control the browser. Finish your changes on the page, then let Octo continue.");
  });

  it("clears user-initiated continuation when page/identity changes", async () => {
    await render(); await click("browser-human-input-takeover");
    props = { ...props, identityKey: "another-page", humanControlConfirmed: true }; await render();
    expect(container.textContent).not.toContain("Let Octo continue");
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("keeps a failed continuation readable beside its retry action without relying on a tooltip", async () => {
    const message = "The connection was lost while continuing the browser task. Your changes are still on the page; reconnect and let Octo continue when ready.";
    props.request = { version: 1, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props.humanControlConfirmed = true;
    props.onContinue = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(true);
    await render();
    await click("browser-human-input-continue");
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe(message);
    expect(alert.hasAttribute("title")).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')!.disabled).toBe(false);
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a takeover failure arriving after the browser identity changes", async () => {
    let reject!: (cause: Error) => void;
    props.onTakeOver = vi.fn(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
    await render(); await click("browser-human-input-takeover");
    props = { ...props, identityKey: "different-browser", humanControlConfirmed: true };
    await render();
    await act(async () => reject(new Error("Failure from the previous browser")));
    expect(container.textContent).not.toContain("Failure from the previous browser");
    expect(container.textContent).not.toContain("Let Octo continue");
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("does not dismiss a new browser handoff when an old continuation finishes", async () => {
    let finish!: (sent: boolean) => void;
    props.request = { version: 1, handoffId: "first", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props.humanControlConfirmed = true;
    props.onContinue = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await render(); await click("browser-human-input-continue");
    props = { ...props, identityKey: "different-browser", request: { ...props.request, handoffId: "second" }, onContinue: vi.fn(async () => true) };
    await render();
    await act(async () => finish(true));
    expect(container.textContent).toContain("Let Octo continue");
    expect(props.onContinue).not.toHaveBeenCalled();
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
  });

  it("asks the person to answer a cookie notice the browser could not decline", async () => {
    props.request = { version: 1, handoffId: "notice", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, kind: "cookies", fields: [{ label: "Highlighted button 1" }, { label: "Highlighted button 2" }] };
    props.humanControlConfirmed = true;
    await render();
    expect(container.textContent).toContain("Answer the highlighted cookie notice, then let Octo continue.");
    expect(container.textContent).not.toContain("highlighted field");
    expect(container.textContent).not.toContain("Keep passwords and codes out of chat");
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
  });

  it("asks the person to press a highlighted button that is theirs, such as a booking's final button", async () => {
    props.request = { version: 1, handoffId: "step", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted button 1" }] };
    props.humanControlConfirmed = true;
    await render();
    expect(container.textContent).toContain("Press the highlighted button on the page when you're ready, then let Octo continue.");
    expect(container.textContent).not.toContain("highlighted field");
    expect(container.textContent).not.toContain("Keep passwords and codes out of chat");
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
  });

  it("words a pause by what it highlights: fields are filled, buttons pressed", () => {
    const field = (n: number) => ({ label: `Highlighted field ${n}` });
    const button = (n: number) => ({ label: `Highlighted button ${n}` });
    expect(humanInputGuidance([field(1)])).toBe("Fill the highlighted field on the page, then let Octo continue. Keep passwords and codes out of chat.");
    expect(humanInputGuidance([field(1), field(2)])).toBe("Fill the 2 highlighted fields on the page, then let Octo continue. Keep passwords and codes out of chat.");
    expect(humanInputGuidance([button(1)])).toBe("Press the highlighted button on the page when you're ready, then let Octo continue.");
    expect(humanInputGuidance([field(1), field(2), button(1)])).toBe("Fill the 2 highlighted fields and press the highlighted button on the page when you're ready, then let Octo continue. Keep passwords and codes out of chat.");
  });

  it("keeps generic Done after manual navigation removes origin-bound guidance", async () => {
    props.request = { version: 1, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props.humanControlConfirmed = true;
    await render();
    expect(container.textContent).toContain("highlighted field");
    props = { ...props, request: null };
    await render();
    expect(container.textContent).not.toContain("highlighted field");
    expect(container.textContent).toContain("Finish your changes on the page");
    expect(container.textContent).toContain("Let Octo continue");
    expect(props.onContinue).not.toHaveBeenCalled();
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
  });

  it("expires field guidance without losing the manual step, and gates unavailable dispatch", async () => {
    vi.useFakeTimers();
    props.request = { version: 1, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 1000, fields: [{ label: "Highlighted field 1" }] };
    props.humanControlConfirmed = true; props.canContinue = false; await render();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')!.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1001));
    expect(container.textContent).not.toContain("highlighted field");
    expect(container.textContent).toContain("Let Octo continue");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')!.disabled).toBe(true);
    expect(props.onContinue).not.toHaveBeenCalled();
  });
});
