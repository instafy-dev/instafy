// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTranscriptViewport } from "../ChatTranscriptViewport";

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

  async function renderViewport(options: { scrollPaddingBottom?: number | null; header?: boolean; onScrollbarWidthChange?: (width: number) => void } = {}) {
    const scrollContainerRef = createRef<HTMLDivElement>();
    await act(async () => {
      root.render(
        <ChatTranscriptViewport
          ariaLabel="Conversation"
          scrollContainerRef={scrollContainerRef}
          scrollPaddingBottom={options.scrollPaddingBottom}
          onScrollbarWidthChange={options.onScrollbarWidthChange}
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

  it("reports native scrollbar space as it changes without remounting the transcript", async () => {
    const onScrollbarWidthChange = vi.fn();
    const { scroller, scrollContainerRef } = await renderViewport({ onScrollbarWidthChange, header: true });
    const header = container.querySelector<HTMLElement>('[data-testid="chat-transcript-header"]')!;
    Object.defineProperty(scroller, "offsetWidth", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 385 });
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(onScrollbarWidthChange).toHaveBeenLastCalledWith(15);
    expect(header.style.paddingInlineEnd).toBe("15px");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 400 });
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(onScrollbarWidthChange).toHaveBeenLastCalledWith(0);
    expect(Number.parseFloat(header.style.paddingInlineEnd)).toBe(0);
    expect(scrollContainerRef.current).toBe(scroller);
  });
});
