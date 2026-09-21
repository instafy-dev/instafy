// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatComposerLayoutState } from "../useChatComposerLayoutState";

// The composer overlays the bottom of the transcript, so the transcript
// needs bottom padding equal to that overlap. The two nodes arrive at
// different moments; the padding used to be measured once and stay at zero
// when the scroller was not mounted yet, leaving the last message under the
// composer.

const rect = (top: number, bottom: number): DOMRect =>
  ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

let reported: string | undefined;

function Harness({ mountScroller }: { mountScroller: boolean }) {
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const flag = useRef(false);
  const num = useRef(0);
  const state = useChatComposerLayoutState({
    activeConversationId: "conversation-1",
    autoScrollPendingRef: flag,
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
    lastComposerScrollTopRef: num,
    lastScrollHeightRef: num,
    queuedSummaryItemCount: 0,
    recordScrollPosition: () => {},
    requestOlderMessages: () => {},
    rootRef,
    scrollContainerRef,
    sendingAttachment: false,
    shouldAutoScrollRef: flag,
    showBrowserSessionPageStrip: false,
    totalQueuedCount: 0,
    touchLikeInput: false,
    voiceHoldActive: false,
    voiceInputListening: false,
  });
  reported = state.chatScrollPaddingBottom;
  return (
    <div ref={rootRef}>
      {mountScroller ? (
        <div
          data-testid="scroller"
          ref={(node) => {
            if (node) node.getBoundingClientRect = () => rect(114, 1132);
            scrollContainerRef.current = node;
          }}
        />
      ) : null}
      <div
        data-testid="overlay"
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => rect(1074, 1132);
          composerOverlayRef.current = node;
        }}
      />
    </div>
  );
}

describe("transcript padding under the composer", () => {
  let container: HTMLDivElement;
  let root: Root;
  // Frames are cancellable, as in a browser: detaching cancels a pending
  // measurement, so a swapped-out scroller is never measured after the fact.
  let frames: Map<number, () => void>;
  let nextFrameId: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    reported = undefined;
    frames = new Map();
    nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const flushFrames = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame();
    });
  };

  it("measures the overlap once the scroller mounts, not only if it was there first", async () => {
    await act(async () => root.render(<Harness mountScroller={false} />));
    await flushFrames();
    expect(reported).toBeUndefined();

    await act(async () => root.render(<Harness mountScroller />));
    await flushFrames();
    // 1132 - 1074 = 58px of composer over the scroller, plus 12px of air.
    expect(reported).toBe("70px");
  });

  it("re-measures against a scroller that was swapped for a new one", async () => {
    await act(async () => root.render(<Harness mountScroller />));
    await flushFrames();
    expect(reported).toBe("70px");

    await act(async () => root.render(<Harness mountScroller={false} />));
    await flushFrames();
    expect(reported).toBeUndefined();

    await act(async () => root.render(<Harness mountScroller />));
    await flushFrames();
    expect(reported).toBe("70px");
  });
});
