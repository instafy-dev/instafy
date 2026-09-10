// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  async function renderViewport(options: { scrollPaddingBottom?: number | null; header?: boolean } = {}) {
    const scrollContainerRef = createRef<HTMLDivElement>();
    await act(async () => {
      root.render(
        <ChatTranscriptViewport
          ariaLabel="Conversation"
          scrollContainerRef={scrollContainerRef}
          scrollPaddingBottom={options.scrollPaddingBottom}
          header={options.header ? <button type="button">Participants</button> : undefined}
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

  it("keeps presence outside the scrolling messages and reserves the faded area for reveals", async () => {
    const { scroller } = await renderViewport({ header: true });
    const header = container.querySelector('[data-testid="chat-transcript-header"]');
    expect(header?.textContent).toBe("Participants");
    expect(scroller.contains(header)).toBe(false);
    expect(header?.parentElement).toBe(scroller.parentElement);
    expect(scroller.className).toContain("chat-transcript-scroll-with-header");
    expect(scroller.style.paddingTop).toBe("48px");
    expect(scroller.style.scrollPaddingTop).toBe("48px");
    expect(scroller.style.background).toBe("");
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
});

/**
 * The speaker pill owns only its identity and fade in/out. The transcript
 * viewport owns the shared presence placement and message fade.
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
