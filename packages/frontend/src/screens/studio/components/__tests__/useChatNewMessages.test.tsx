// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { useChatNewMessages } from "../useChatNewMessages";
import { ChatNewMessagesButton } from "../ChatNewMessagesButton";

type Options = Parameters<typeof useChatNewMessages>[0];
const message = (index: number, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  timestamp: index * 1000, role: "user", authorId: "other-person", content: `Message ${index}`,
  ...overrides,
});

describe("new arrivals above the composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let options: Options;
  let metrics: { scrollTop: number; scrollHeight: number; clientHeight: number };
  let result: ReturnType<typeof useChatNewMessages>;
  let onJumpToLatest: ReturnType<typeof vi.fn>;
  const action = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-new-messages"]');
  function Harness() {
    result = useChatNewMessages(options);
    return <><div ref={node => {
      options.scrollContainerRef.current = node;
      if (node) Object.defineProperties(node, {
        scrollTop: { configurable: true, get: () => metrics.scrollTop },
        scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
        clientHeight: { configurable: true, get: () => metrics.clientHeight },
      });
    }} />{result.hasNewMessages ? <ChatNewMessagesButton onPress={result.jumpToLatest} /> : null}</>;
  }
  const render = async () => { await act(async () => root.render(<Harness />)); };
  const scroll = async () => { await act(async () => options.scrollContainerRef.current!.dispatchEvent(new Event("scroll"))); };
  const update = async (values: Partial<Options>) => { options = { ...options, ...values }; await render(); };
  const setRoute = (key: string) => window.history.replaceState({ key, idx: 1 }, "", "/studio");

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    metrics = { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 };
    onJumpToLatest = vi.fn();
    options = { visitKey: "visit-a", routeKey: "route-a", currentUserId: "viewer-a", enabled: true,
      hasResolvedHistory: true, arrivalMessages: [message(1)], messageTargetActive: false,
      scrollContainerRef: createRef<HTMLDivElement>(), shouldAutoScrollRef: { current: false },
      isReadingReady: () => true, onJumpToLatest };
    setRoute(options.routeKey);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("baselines initial history and preserves reading position when another person sends a message", async () => {
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(1), message(2)] });
    expect(action()?.textContent).toBe("New messages");
    expect(action()?.getAttribute("aria-label")).toBe("New messages, jump to latest");
    expect(action()?.className).toContain("min-h-11");
    expect(action()?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(metrics.scrollTop).toBe(100);
    expect(onJumpToLatest).not.toHaveBeenCalled();
  });

  it("waits for initial authorization/history even when local or SSE messages already exist", async () => {
    await update({ visitKey: "new-visit", hasResolvedHistory: false, arrivalMessages: [message(1)] });
    await update({ arrivalMessages: [message(1), message(2)] });
    expect(action()).toBeNull();
    await update({ hasResolvedHistory: true, arrivalMessages: [message(1), message(2), message(3)] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(1), message(2), message(3), message(4)] });
    expect(action()).not.toBeNull();
  });

  it("baselines a successful empty history then notices its first arrival", async () => {
    await update({ visitKey: "empty-visit", arrivalMessages: [] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(1)] });
    expect(action()).not.toBeNull();
  });

  it("does not signal older rows, duplicate rows, or content edits", async () => {
    await update({ arrivalMessages: [message(0), message(1, { content: "Edited" })] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(0), message(1)] });
    expect(action()).toBeNull();
  });

  it("accepts a distinct authoritative newest-page arrival at the same timestamp", async () => {
    await update({ arrivalMessages: [message(1), message(2, { timestamp: 1000 })] });
    expect(action()).not.toBeNull();
  });

  it.each([
    { authorId: "viewer-a" },
    { id: "user-local-pending" },
    { id: "assistant-local-placeholder", role: "assistant" as const },
    { role: "assistant" as const, messageType: "reasoning" },
    { content: "" },
  ])("ignores own, synthetic, timeline, or empty arrivals: %j", async overrides => {
    await update({ arrivalMessages: [message(1), message(2, overrides)] });
    expect(action()).toBeNull();
  });

  it("counts an assistant response even when its createdBy is the viewer", async () => {
    await update({ arrivalMessages: [message(1), message(2, { role: "assistant", authorId: "viewer-a" })] });
    expect(action()).not.toBeNull();
  });

  it("waits for content in a newly persisted empty response", async () => {
    await update({ arrivalMessages: [message(1), message(2, { role: "assistant", content: "" })] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(1), message(2, { role: "assistant", content: "Reply" })] });
    expect(action()).not.toBeNull();
  });

  it("notices first content in a baseline assistant row while ordinary edits stay quiet", async () => {
    const blank = message(1, { role: "assistant", content: "", authorId: "viewer-a" });
    const existing = message(2);
    await update({ visitKey: "baseline-stream", arrivalMessages: [blank, existing] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [blank, { ...existing, content: "Edited existing message" }] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [{ ...blank, content: "First reply text" }, existing] });
    expect(action()).not.toBeNull();
    await act(async () => action()!.click());
    await update({ arrivalMessages: [{ ...blank, content: "First reply text, continued" }, existing] });
    expect(action()).toBeNull();
  });

  it("does not display arrivals when ordinary live following is active", async () => {
    options.shouldAutoScrollRef.current = true;
    await update({ arrivalMessages: [message(1), message(2)] });
    expect(action()).toBeNull();
    options.shouldAutoScrollRef.current = false;
    await render();
    expect(action()).toBeNull();
  });

  it("clears only when the visible live reader reaches bottom, without resurfacing seen arrivals", async () => {
    await update({ arrivalMessages: [message(1), message(2)] });
    await scroll();
    expect(action()).not.toBeNull();
    metrics.scrollTop = 780;
    await scroll();
    expect(action()).toBeNull();
    metrics.scrollTop = 100;
    await update({ arrivalMessages: [message(1), message(2)] });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(1), message(2), message(3)] });
    expect(action()).not.toBeNull();
  });

  it("keeps the indicator at a historical window's bottom until it returns to live history", async () => {
    options.shouldAutoScrollRef.current = true;
    await update({ messageTargetActive: true, arrivalMessages: [message(1), message(2)] });
    metrics.scrollTop = 800;
    await scroll();
    expect(action()).not.toBeNull();
    await act(async () => action()!.click());
    expect(onJumpToLatest).toHaveBeenCalledOnce();
    expect(action()).toBeNull();
  });

  it("uses the latest live jump callback without navigating on arrival", async () => {
    await update({ arrivalMessages: [message(1), message(2)] });
    const liveJump = vi.fn();
    await update({ onJumpToLatest: liveJump });
    await act(async () => action()!.click());
    expect(liveJump).toHaveBeenCalledOnce();
    expect(onJumpToLatest).not.toHaveBeenCalled();
    expect(action()).toBeNull();
  });

  it("does not trap the historical exit when target loading/reveal has failed", async () => {
    await update({ messageTargetActive: true, isReadingReady: () => false, arrivalMessages: [message(1), message(2)] });
    await act(async () => action()!.click());
    expect(onJumpToLatest).toHaveBeenCalledOnce();
  });

  it.each(["account", "visit"] as const)("resets on %s change and never exposes the preceding indicator", async change => {
    await update({ arrivalMessages: [message(1), message(2)] });
    expect(action()).not.toBeNull();
    await update(change === "account" ? { currentUserId: "viewer-b" } : { visitKey: "visit-b" });
    expect(action()).toBeNull();
    await update({ arrivalMessages: [message(1), message(2), message(3)] });
    expect(action()).not.toBeNull();
  });

  it("rejects stale actions before Router catches up", async () => {
    await update({ arrivalMessages: [message(1), message(2)] });
    setRoute("route-b");
    await act(async () => action()!.click());
    expect(onJumpToLatest).not.toHaveBeenCalled();
    expect(action()).not.toBeNull();
  });

  it("does not clear unread arrivals from a hidden pane's programmatic bottom scroll", async () => {
    await update({ arrivalMessages: [message(1), message(2)] });
    metrics.scrollTop = 800;
    container.setAttribute("hidden", "");
    await scroll();
    expect(action()).not.toBeNull();
    container.removeAttribute("hidden");
    await scroll();
    expect(action()).toBeNull();
  });

  it("suppresses the action while access is unresolved or the chat surface is inactive", async () => {
    await update({ arrivalMessages: [message(1), message(2)] });
    await update({ hasResolvedHistory: false });
    expect(action()).toBeNull();
    await update({ hasResolvedHistory: true, enabled: false });
    expect(action()).toBeNull();
  });
});
