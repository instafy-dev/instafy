// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSpeakerStickyOverlay, ChatTranscriptViewport } from "../ChatTranscriptViewport";
import type { StickyChatSpeaker } from "../chatSpeakerMarker";

const assistantSpeaker: StickyChatSpeaker = {
  kind: "assistant",
  handle: "octo",
  avatarSeed: "octo",
};

const humanSpeaker: StickyChatSpeaker = {
  kind: "human",
  label: "Taylor",
  avatarSeed: "user-1",
};

/**
 * Founder feedback, fourth round on this area: "what about the gray/background
 * bar we have between the text and the tabs, did we ever fix/remove that or
 * make it better?" Three backdrop bands behind a floating pill (a solid hold,
 * a tint fade, a backdrop blur) were rejected already; a later top-edge
 * content mask (added to stop the pill sitting on top of readable text) still
 * read as a grey bar to him. The pill has since moved into the conversation
 * roster row above the transcript, so this component no longer needs to know
 * about it at all — these tests pin that the scroller is plain: no mask, no
 * speaker layer or band painted over message text. An optional jump-to-latest
 * action is separate from the removed speaker decoration.
 */
describe("ChatTranscriptViewport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderViewport(options: {
    scrollPaddingBottom?: number | null;
    onJumpToLatest?: () => void;
    hasNewMessages?: boolean;
  } = {}) {
    const scrollContainerRef = createRef<HTMLDivElement>();
    await act(async () => {
      root.render(
        <ChatTranscriptViewport
          ariaLabel="Conversation"
          scrollContainerRef={scrollContainerRef}
          scrollPaddingBottom={options.scrollPaddingBottom}
          onJumpToLatest={options.onJumpToLatest}
          hasNewMessages={options.hasNewMessages}
        >
          <p data-testid="transcript-line">First message</p>
        </ChatTranscriptViewport>,
      );
    });
    const scroller = container.querySelector<HTMLElement>('[data-testid="chat-message-scroll"]');
    if (!scroller) {
      throw new Error("ChatTranscriptViewport did not render its scroller");
    }
    return { scrollContainerRef, scroller };
  }

  function readStyle(element: HTMLElement): Record<string, string | undefined> {
    // jsdom keeps vendor-prefixed and mask properties as plain fields on the
    // style declaration, so read it untyped.
    return element.style as unknown as Record<string, string | undefined>;
  }

  it("renders a plain scroller with no mask, no fade attribute, and no sticky layer", async () => {
    const { scroller } = await renderViewport({ scrollPaddingBottom: 24 });

    expect(container.querySelector('[data-testid="chat-speaker-sticky-layer"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-speaker-sticky-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-speaker-sticky-backdrop"]')).toBeNull();
    expect(scroller.dataset.chatTranscriptFade).toBeUndefined();
    expect(readStyle(scroller).maskImage || "").toBe("");
    expect(readStyle(scroller).WebkitMaskImage || "").toBe("");
    expect(scroller.style.paddingBottom).toBe("24px");
  });

  it("keeps the scroller's own testid, hands out the scroll ref, and preserves the scroll orchestration props", async () => {
    const { scrollContainerRef, scroller } = await renderViewport();

    expect(scrollContainerRef.current).toBe(scroller);
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.getAttribute("role")).toBe("log");
    expect(scroller.getAttribute("aria-label")).toBe("Conversation");
    expect(scroller.querySelector('[data-testid="transcript-line"]')).not.toBeNull();
  });

  it("never sets a mask image regardless of scrollPaddingBottom", async () => {
    const withPadding = await renderViewport({ scrollPaddingBottom: 24 });
    const withoutPadding = await renderViewport();

    for (const { scroller } of [withPadding, withoutPadding]) {
      expect(readStyle(scroller).maskImage || "").toBe("");
      expect(readStyle(scroller).WebkitMaskImage || "").toBe("");
    }
  });

  it("offers an accessible jump action above the composer without changing transcript content", async () => {
    const onJumpToLatest = vi.fn();
    const { scroller } = await renderViewport({ onJumpToLatest, scrollPaddingBottom: 144 });
    let button = container.querySelector<HTMLButtonElement>('[data-testid="chat-jump-to-latest"]')!;
    expect(button.getAttribute("aria-label")).toBe("Jump to latest");
    expect(button.parentElement?.style.bottom).toBe("144px");
    expect(button.className).toContain("pointer-coarse:min-h-11");
    expect(scroller.contains(button)).toBe(false);
    expect(scroller.textContent).toBe("First message");

    await renderViewport({ onJumpToLatest, hasNewMessages: true, scrollPaddingBottom: 144 });
    button = container.querySelector<HTMLButtonElement>('[data-testid="chat-jump-to-latest"]')!;
    expect(button.getAttribute("aria-label")).toBe("New messages, jump to latest");
    expect(button.querySelector('[aria-live="polite"]')?.textContent).toBe("New messages");
    await act(async () => { button.click(); });
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    await renderViewport();
    expect(container.querySelector('[data-testid="chat-jump-to-latest"]')).toBeNull();
  });

  it("returns keyboard focus to the transcript after activating the jump action", async () => {
    const onJumpToLatest = vi.fn();
    const { scroller } = await renderViewport({ onJumpToLatest });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-jump-to-latest"]')!;
    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(scroller);
    expect(scroller.tabIndex).toBe(-1);
  });

  it("preserves composer focus when pressing the jump action with a pointer", async () => {
    const onJumpToLatest = vi.fn();
    await renderViewport({ onJumpToLatest });
    const input = document.createElement("textarea");
    container.appendChild(input);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-jump-to-latest"]')!;
    await act(async () => {
      input.focus();
      button.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
      // jsdom does not implement the native focus default action of mousedown.
      // Deliver it explicitly so this checks the real Button focus prevention.
      button.focus();
    });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true, cancelable: true }));
      button.click();
    });
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });
});

/**
 * ChatSpeakerStickyOverlay itself is unchanged by the move — ChatPanel now
 * renders it directly inside the roster row instead of ChatTranscriptViewport
 * rendering it as an absolute sibling of the scroller. These tests pin its
 * own behavior (fade in/out, which pill kind it shows) independent of where
 * it is mounted.
 */
describe("ChatSpeakerStickyOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderOverlay(speaker: StickyChatSpeaker | null) {
    const overlayRef = createRef<HTMLDivElement>();
    await act(async () => {
      root.render(<ChatSpeakerStickyOverlay ref={overlayRef} speaker={speaker} />);
    });
    const overlay = container.querySelector<HTMLElement>('[data-testid="chat-speaker-sticky-overlay"]');
    if (!overlay) {
      throw new Error("ChatSpeakerStickyOverlay did not render");
    }
    return { overlay, overlayRef };
  }

  it("paints nothing behind the pill: no backdrop band of any kind", async () => {
    const { overlay } = await renderOverlay(assistantSpeaker);

    expect(overlay.children).toHaveLength(1);
    const pillWrapper = overlay.firstElementChild as HTMLElement;
    expect(pillWrapper.textContent).toContain("octo");
    expect(pillWrapper.className).not.toContain("inset-x");
    expect(pillWrapper.className).not.toContain("bg-gradient");
  });

  it("fades in/out and hands out the ref", async () => {
    const shown = await renderOverlay(assistantSpeaker);
    expect(shown.overlayRef.current).toBe(shown.overlay);
    expect(shown.overlay.getAttribute("aria-hidden")).toBeNull();
    expect((shown.overlay.firstElementChild as HTMLElement).className).toContain("opacity-100");

    const human = await renderOverlay(humanSpeaker);
    expect(human.overlay.querySelector('[data-testid="chat-human-speaker-pill"]')?.textContent).toContain(
      "Taylor",
    );

    const hidden = await renderOverlay(null);
    expect(hidden.overlay.getAttribute("aria-hidden")).toBe("true");
    expect((hidden.overlay.firstElementChild as HTMLElement).className).toContain("opacity-0");
    expect(hidden.overlay.textContent).toBe("");
  });
});
