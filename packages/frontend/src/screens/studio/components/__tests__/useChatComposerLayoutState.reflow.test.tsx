// @vitest-environment jsdom

import { act, useRef, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatComposerLayoutState } from "../useChatComposerLayoutState";

// Opening a pane beside chat narrows the transcript from the full panel to the
// chat column. Every message grows taller and the browser's scroll anchoring
// raises a scroll event that leaves the transcript far from the bottom. That
// event is a reflow, not the reader scrolling away: a transcript that was
// following the latest message must keep following it.

let state: ReturnType<typeof useChatComposerLayoutState> | null = null;
let scroller: HTMLDivElement | null = null;
let autoScrollRef: MutableRefObject<boolean> | null = null;
let pinnedRef: MutableRefObject<number | null> | null = null;
const box = { width: 1152, height: 848, scrollHeight: 1578 };

function Harness() {
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef(false);
  const autoScroll = useRef(true);
  autoScrollRef = autoScroll;
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const pinned = useRef<number | null>(null);
  pinnedRef = pinned;
  state = useChatComposerLayoutState({
    activeConversationId: "conversation-1",
    autoScrollPendingRef: pending,
    browserModeActive: false,
    browserSessionOpen: false,
    chatSendQueueExpanded: false,
    compactBrowserViewport: false,
    composerGhostSuggestionRemainder: null,
    composerOverlayRef,
    editingQueuedItemActive: false,
    hasMoreHistory: false,
    imageAttachmentCount: 0,
    inputValue: "",
    isChatInputFocused: () => false,
    isHistoryLoading: false,
    lastComposerScrollTopRef: lastTop,
    lastScrollHeightRef: lastHeight,
    pinnedScrollTopRef: pinned,
    queuedSummaryItemCount: 0,
    recordScrollPosition: () => {},
    requestOlderMessages: () => {},
    rootRef,
    scrollContainerRef,
    sendingAttachment: false,
    shouldAutoScrollRef: autoScroll,
    showBrowserSessionPageStrip: false,
    totalQueuedCount: 0,
    touchLikeInput: false,
    voiceHoldActive: false,
    voiceInputListening: false,
  });
  return (
    <div ref={rootRef}>
      <div
        ref={(node) => {
          scrollContainerRef.current = node;
          scroller = node;
          if (node) {
            Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
            Object.defineProperty(node, "clientHeight", { configurable: true, get: () => box.height });
            Object.defineProperty(node, "clientWidth", { configurable: true, get: () => box.width });
          }
        }}
      />
      <div ref={composerOverlayRef} />
    </div>
  );
}

async function scrollEvent(top: number) {
  await act(async () => {
    scroller!.scrollTop = top;
    state!.handleScroll();
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(box, { width: 1152, height: 848, scrollHeight: 1578 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  state = null;
  scroller = null;
  autoScrollRef = null;
  pinnedRef = null;
});

describe("useChatComposerLayoutState: a reflow is not the reader scrolling", () => {
  it("keeps following the latest message when a pane narrows the transcript", async () => {
    await act(async () => root.render(<Harness />));
    await scrollEvent(1578 - 848);
    expect(autoScrollRef!.current).toBe(true);

    // A pane opens beside chat: 1152px -> 420px, the transcript grows and
    // scroll anchoring leaves it 492px above the bottom (measured live).
    Object.assign(box, { width: 420, scrollHeight: 2229 });
    await scrollEvent(889);
    expect(autoScrollRef!.current).toBe(true);
    expect(scroller!.scrollTop).toBe(2229 - 848);
  });

  it("still lets the reader scroll up, and does not pull a reader back down on a reflow", async () => {
    await act(async () => root.render(<Harness />));
    await scrollEvent(1578 - 848);

    // The reader scrolls up at the same size: following stops.
    await scrollEvent(200);
    expect(autoScrollRef!.current).toBe(false);

    // A reflow while they read older messages leaves them where they are.
    Object.assign(box, { width: 420, scrollHeight: 2229 });
    await scrollEvent(300);
    expect(autoScrollRef!.current).toBe(false);
    expect(scroller!.scrollTop).toBe(300);
  });
});

// The same holds when the transcript grows between our own bottom pin and the
// scroll event the browser raises for it a frame later. Measured on a cold load:
// the pin landed at the bottom, a late row added 31px before that event, and
// reading the event as "the reader scrolled up" left the newest message under
// the composer.
describe("useChatComposerLayoutState: the echo of our own pin is not the reader scrolling", () => {
  it("keeps following and closes the gap when rows grew after the pin", async () => {
    await act(async () => root.render(<Harness />));
    pinnedRef!.current = 1578 - 848;
    Object.assign(box, { scrollHeight: 1578 + 31 });
    await scrollEvent(1578 - 848);
    expect(autoScrollRef!.current).toBe(true);
    expect(scroller!.scrollTop).toBe(1609 - 848);
    expect(pinnedRef!.current).toBe(1609 - 848);
  });

  it("keeps following when scroll anchoring carried the view down with rows that grew above it", async () => {
    await act(async () => root.render(<Harness />));
    pinnedRef!.current = 1578 - 848;
    // 20px grew above the browser's scroll anchor, which moved the view down by
    // that much, and 40px grew below it.
    Object.assign(box, { scrollHeight: 1578 + 60 });
    await scrollEvent(1578 - 848 + 20);
    expect(autoScrollRef!.current).toBe(true);
    expect(scroller!.scrollTop).toBe(1638 - 848);
    expect(pinnedRef!.current).toBe(1638 - 848);

    // A move up is still measured from where the view was left.
    await scrollEvent(1638 - 848 - 50);
    expect(autoScrollRef!.current).toBe(false);
    expect(pinnedRef!.current).toBeNull();
  });

  it("still stops following once the reader moves off the pin, even back onto it later", async () => {
    await act(async () => root.render(<Harness />));
    pinnedRef!.current = 1578 - 848;
    Object.assign(box, { scrollHeight: 1578 + 31 });

    await scrollEvent(600);
    expect(autoScrollRef!.current).toBe(false);
    expect(pinnedRef!.current).toBeNull();

    // Returning to the old pinned offset is the reader too, not our echo.
    await scrollEvent(1578 - 848);
    expect(autoScrollRef!.current).toBe(false);
    expect(scroller!.scrollTop).toBe(1578 - 848);
  });

  it("does not start following on an echo the reader had already left", async () => {
    await act(async () => root.render(<Harness />));
    autoScrollRef!.current = false;
    pinnedRef!.current = 1578 - 848;
    Object.assign(box, { scrollHeight: 1578 + 31 });
    await scrollEvent(1578 - 848);
    expect(autoScrollRef!.current).toBe(false);
    expect(scroller!.scrollTop).toBe(1578 - 848);
  });
});
