// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHumanInputControls } from "../BrowserHumanInputControls";
import { BROWSER_HUMAN_INPUT_CONTINUE_PROMPT, type BrowserHumanInputOptions } from "../useBrowserHumanInput";

describe("BrowserHumanInputControls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: BrowserHumanInputOptions;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    props = { identityKey: "user/project/conversation/shared/runtime/page", request: null, canTakeOver: true,
      humanControlConfirmed: false, onTakeOver: vi.fn(async () => true), onContinue: vi.fn(async () => true) };
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async () => { await act(async () => root.render(<BrowserHumanInputControls {...props} />)); };
  const click = async (testId: string) => {
    if (testId === "browser-human-input-takeover" && !document.querySelector('[data-testid="browser-human-input-takeover"]')) {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-request"]')!.click());
    }
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
  };

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
    expect(container.textContent).not.toContain("Let AI continue");
  });

  it("does not continue automatically or duplicate an in-flight explicit continuation", async () => {
    let finish!: (sent: boolean) => void;
    props.request = { version: 1, handoffId: "handoff", origin: "https://example.test", createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, fields: [{ label: "Highlighted field 1" }] };
    props.humanControlConfirmed = true;
    props.onContinue = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await render(); expect(props.onContinue).not.toHaveBeenCalled();
    await click("browser-human-input-continue"); await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(container.textContent).toContain("was not sent");
    expect(container.textContent).toContain("Let AI continue");
  });

  it("clears user-initiated continuation when page/identity changes", async () => {
    await render(); await click("browser-human-input-takeover");
    props = { ...props, identityKey: "another-page", humanControlConfirmed: true }; await render();
    expect(container.textContent).not.toContain("Let AI continue");
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("ignores a takeover failure arriving after the browser identity changes", async () => {
    let reject!: (cause: Error) => void;
    props.onTakeOver = vi.fn(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
    await render(); await click("browser-human-input-takeover");
    props = { ...props, identityKey: "different-browser", humanControlConfirmed: true };
    await render();
    await act(async () => reject(new Error("Failure from the previous browser")));
    expect(container.textContent).not.toContain("Failure from the previous browser");
    expect(container.textContent).not.toContain("Let AI continue");
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
    expect(container.textContent).toContain("Let AI continue");
    expect(props.onContinue).not.toHaveBeenCalled();
    await click("browser-human-input-continue");
    expect(props.onContinue).toHaveBeenCalledExactlyOnceWith(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
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
    expect(container.textContent).toContain("Let AI continue");
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
    expect(container.textContent).toContain("Let AI continue");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="browser-human-input-continue"]')!.disabled).toBe(true);
    expect(props.onContinue).not.toHaveBeenCalled();
  });
});
