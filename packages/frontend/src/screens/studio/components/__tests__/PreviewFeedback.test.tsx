// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskConfirmStrip, ASK_CONFIRM_ARM_MS } from "../previewHost/AskConfirmStrip";
import { PreviewFeedbackLane } from "../previewHost/PreviewFeedback";
import { LocationBlockedNotice, LocationToast, LOCATION_BLOCKED_MS, LOCATION_TOAST_MS } from "../previewHost/PreviewLocation";

describe("preview feedback decisions and lifetime", () => {
  let root: Root;
  let container: HTMLDivElement;
  let origin: HTMLButtonElement;
  const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
  const advance = async (ms: number) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
  const click = async (id: string) => { await act(async () => byId(id).click()); };
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    origin = document.createElement("button");
    document.body.append(origin);
    origin.focus();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); origin.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retains the full decision, does not take focus, and accepts Send only once after arming", async () => {
    const onSend = vi.fn(); const onCancel = vi.fn();
    const line = "Compare the complete delivery and cancellation terms for the blue running shoes before placing the order, including the additional fees and the expected arrival date. · via Running shoes";
    await render(<AskConfirmStrip line={line} onSend={onSend} onCancel={onCancel} />);
    expect(document.activeElement).toBe(origin);
    expect(byId("site-ask-confirm").getAttribute("role")).toBe("group");
    expect(byId("site-ask-confirm-line").textContent).toBe(`Send “${line}” as you?`);
    await click("site-ask-confirm-send");
    await advance(ASK_CONFIRM_ARM_MS - 1);
    await click("site-ask-confirm-send");
    expect(onSend).not.toHaveBeenCalled();
    await advance(1);
    await act(async () => {
      byId("site-ask-confirm-send").click();
      byId("site-ask-confirm-send").click();
      byId("site-ask-confirm-cancel").click();
    });
    expect(onSend).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape cancels only from the prompt and closing restores focus it owned", async () => {
    const onCancel = vi.fn();
    await render(<AskConfirmStrip line="Compare these reports." onSend={vi.fn()} onCancel={onCancel} />);
    await act(async () => origin.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => byId("site-ask-confirm-cancel").focus());
    await act(async () => byId("site-ask-confirm-cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledOnce();
    await click("site-ask-confirm-cancel");
    expect(onCancel).toHaveBeenCalledOnce();
    await render(null);
    expect(document.activeElement).toBe(origin);
  });

  it("does not restore focus after the person has moved away from a prompt", async () => {
    await render(<AskConfirmStrip line="Compare these reports." onSend={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => byId("site-ask-confirm-cancel").focus());
    const elsewhere = document.createElement("button"); document.body.append(elsewhere);
    elsewhere.focus();
    await render(null);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it.each(["location", "blocked"] as const)("returns focus from a removed %s notice to its latest entry point only", async kind => {
    const notice = kind === "location"
      ? <LocationToast title="Cafés" onStop={vi.fn()} onDismiss={vi.fn()} />
      : <LocationBlockedNotice onDismiss={vi.fn()} />;
    await render(notice);
    const latest = document.createElement("button"); document.body.append(latest);
    latest.focus();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss location notice"]')!.focus());
    await render(null);
    expect(document.activeElement).toBe(latest);

    await render(notice);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss location notice"]')!.focus());
    origin.focus();
    await render(null);
    expect(document.activeElement).toBe(origin);
    latest.remove();
  });

  it("arms a replacement question independently and accepts its own decision", async () => {
    const onSend = vi.fn();
    await render(<AskConfirmStrip line="First question" onSend={onSend} onCancel={vi.fn()} />);
    await advance(ASK_CONFIRM_ARM_MS);
    await render(<AskConfirmStrip line="Second question" onSend={onSend} onCancel={vi.fn()} />);
    await click("site-ask-confirm-send");
    expect(onSend).not.toHaveBeenCalled();
    await advance(ASK_CONFIRM_ARM_MS);
    await click("site-ask-confirm-send");
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("coordinates current decisions and location controls, and removes the whole lane when inactive", async () => {
    const dismissLocation = vi.fn();
    const confirmation = { line: "Compare these reports.", onSend: vi.fn(), onCancel: vi.fn() };
    const location = { title: "Research", onStop: vi.fn(), onDismiss: dismissLocation };
    const blockedLocation = { onDismiss: vi.fn() };
    const follow = { text: "Alex took over from Sam" };
    await render(<PreviewFeedbackLane {...{ confirmation, location, blockedLocation, follow }} />);
    const notices = [...byId("preview-feedback-scroll").querySelectorAll("[data-testid]")].map(node => node.getAttribute("data-testid"));
    expect(notices.indexOf("site-ask-confirm")).toBeLessThan(notices.indexOf("preview-location-blocked"));
    expect(notices.indexOf("preview-location-blocked")).toBeLessThan(notices.indexOf("preview-location-toast"));
    expect(container.querySelector('[data-testid="follow-note"]')).toBeNull();
    await advance(LOCATION_BLOCKED_MS);
    expect(dismissLocation).not.toHaveBeenCalled();
    expect(blockedLocation.onDismiss).not.toHaveBeenCalled();
    await render(<PreviewFeedbackLane location={location} />);
    await advance(LOCATION_TOAST_MS);
    expect(dismissLocation).toHaveBeenCalledOnce();
    await render(<PreviewFeedbackLane active={false} {...{ confirmation, location, follow }} />);
    expect(container.textContent).toBe("");
    await advance(LOCATION_BLOCKED_MS);
    expect(dismissLocation).toHaveBeenCalledOnce();
    await render(<PreviewFeedbackLane follow={follow} />);
    expect(byId("follow-note").textContent).toBe(follow.text);
  });

  it.each(["location", "blocked"] as const)("does not reset the %s deadline when the parent supplies a new callback", async kind => {
    const first = vi.fn(); const latest = vi.fn();
    const duration = kind === "location" ? LOCATION_TOAST_MS : LOCATION_BLOCKED_MS;
    const notice = (onDismiss: () => void) => kind === "location"
      ? <LocationToast title="Cafés" onStop={vi.fn()} onDismiss={onDismiss} />
      : <LocationBlockedNotice onDismiss={onDismiss} />;
    await render(notice(first));
    await advance(duration - 1_000);
    await render(notice(latest));
    await advance(999);
    expect(latest).not.toHaveBeenCalled();
    await advance(1);
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    await advance(duration);
    expect(latest).toHaveBeenCalledOnce();
  });

  it("preserves remaining reading time while an action has focus or the notice is hovered", async () => {
    const onDismiss = vi.fn();
    await render(<LocationToast title="Cafés" onStop={vi.fn()} onDismiss={onDismiss} />);
    await advance(2_000);
    await act(async () => byId("preview-location-toast-stop").focus());
    await advance(20_000);
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => origin.focus());
    await advance(1_000);
    const pointer = (name: string) => {
      const event = new MouseEvent(name, { bubbles: true, relatedTarget: origin });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      return event;
    };
    await act(async () => byId("preview-location-toast").dispatchEvent(pointer("pointerover")));
    await advance(20_000);
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => byId("preview-location-toast").dispatchEvent(pointer("pointerout")));
    await advance(4_999);
    expect(onDismiss).not.toHaveBeenCalled();
    await advance(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("pauses in a hidden document and resumes the remaining time on return", async () => {
    const onDismiss = vi.fn();
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
    await render(<LocationToast title="Cafés" onStop={vi.fn()} onDismiss={onDismiss} />);
    await advance(2_000);
    hidden = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(20_000);
    expect(onDismiss).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(6_000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("pauses a clipped notice until the lane scrolls it fully into view", async () => {
    let update: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { update = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const onDismiss = vi.fn();
    await render(<LocationToast title="Cafés" onStop={vi.fn()} onDismiss={onDismiss} />);
    const intersection = async (ratio: number) => {
      await act(async () => update!([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver));
    };
    await intersection(1);
    await advance(2_000);
    await intersection(0.5);
    await advance(20_000);
    expect(onDismiss).not.toHaveBeenCalled();
    await intersection(1);
    await advance(6_000);
    expect(onDismiss).toHaveBeenCalledOnce();
    await render(null);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
