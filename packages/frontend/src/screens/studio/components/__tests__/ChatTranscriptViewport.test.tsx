// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_TRANSCRIPT_FADE_MASK_IMAGE,
  CHAT_TRANSCRIPT_FADE_PX,
  ChatTranscriptViewport,
} from "../ChatTranscriptViewport";
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
 * Founder feedback on the sticky speaker pill: "there is still a gray area
 * above the chat somehow?" Every band painted behind the pill (solid hold,
 * tint fade, backdrop blur) smeared bright text on the dark panel into a haze.
 * The rule these tests pin: nothing is painted over the transcript — the
 * scroller's own top edge dissolves, and the pill floats outside the mask.
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

  async function renderViewport(
    stickySpeaker: StickyChatSpeaker | null,
    options: { scrollPaddingBottom?: number | null } = {},
  ) {
    const scrollContainerRef = createRef<HTMLDivElement>();
    const overlayRef = createRef<HTMLDivElement>();
    await act(async () => {
      root.render(
        <ChatTranscriptViewport
          ariaLabel="Conversation"
          scrollContainerRef={scrollContainerRef}
          scrollPaddingBottom={options.scrollPaddingBottom}
          stickySpeaker={stickySpeaker}
          stickySpeakerOverlayRef={overlayRef}
        >
          <p data-testid="transcript-line">First message</p>
        </ChatTranscriptViewport>,
      );
    });
    const scroller = container.querySelector<HTMLElement>('[data-testid="chat-message-scroll"]');
    const overlay = container.querySelector<HTMLElement>('[data-testid="chat-speaker-sticky-overlay"]');
    const layer = container.querySelector<HTMLElement>('[data-testid="chat-speaker-sticky-layer"]');
    if (!scroller || !overlay || !layer) {
      throw new Error("ChatTranscriptViewport did not render its scroller and sticky layer");
    }
    return { layer, overlay, overlayRef, scrollContainerRef, scroller };
  }

  function readStyle(element: HTMLElement): Record<string, string | undefined> {
    // jsdom keeps vendor-prefixed and mask properties as plain fields on the
    // style declaration, so read it untyped.
    return element.style as unknown as Record<string, string | undefined>;
  }

  it("paints nothing behind the pill: no backdrop band of any kind", async () => {
    const { overlay } = await renderViewport(assistantSpeaker);

    expect(container.querySelector('[data-testid="chat-speaker-sticky-backdrop"]')).toBeNull();
    // The overlay holds exactly one thing — the pill's fade wrapper. No
    // sibling strip, gradient or blur spanning the transcript's inset.
    expect(overlay.children).toHaveLength(1);
    const pillWrapper = overlay.firstElementChild as HTMLElement;
    expect(pillWrapper.textContent).toContain("octo");
    expect(pillWrapper.className).not.toContain("inset-x");
    expect(pillWrapper.className).not.toContain("bg-gradient");
  });

  it("floats the pill outside the scroller, as a sibling inside the relative wrapper", async () => {
    const { layer, overlay, scroller } = await renderViewport(assistantSpeaker);

    // The pill is not a descendant of the masked scroller…
    expect(scroller.contains(overlay)).toBe(false);
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.querySelector('[data-testid="transcript-line"]')).not.toBeNull();

    // …it is a sibling layer inside the same relative wrapper, painted above
    // the scroller and never taking pointer events.
    const wrapper = scroller.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain("relative");
    expect(layer.parentElement).toBe(wrapper);
    expect(layer.contains(overlay)).toBe(true);
    expect(layer.className).toContain("absolute");
    expect(layer.className).toContain("top-0");
    expect(layer.className).toContain("z-30");
    expect(layer.className).toContain("pointer-events-none");
    expect(scroller.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Same horizontal inset and top padding as the scroller, so the pill lands
    // exactly where the inline speaker label it covers would be.
    for (const inset of ["px-3", "sm:px-4", "pt-2"]) {
      expect(scroller.className).toContain(inset);
      expect(layer.className).toContain(inset);
    }
  });

  it("masks the scroller's top edge only while a speaker is sticky", async () => {
    const withSpeaker = await renderViewport(assistantSpeaker, { scrollPaddingBottom: 24 });
    expect(withSpeaker.scroller.dataset.chatTranscriptFade).toBe("true");
    expect(readStyle(withSpeaker.scroller).maskImage).toBe(CHAT_TRANSCRIPT_FADE_MASK_IMAGE);
    expect(readStyle(withSpeaker.scroller).WebkitMaskImage).toBe(CHAT_TRANSCRIPT_FADE_MASK_IMAGE);
    expect(withSpeaker.scroller.style.paddingBottom).toBe("24px");

    // Scrolled to the top with nothing sticky: the first message runs to the
    // edge unfaded.
    const idle = await renderViewport(null, { scrollPaddingBottom: 24 });
    expect(idle.scroller.dataset.chatTranscriptFade).toBeUndefined();
    expect(readStyle(idle.scroller).maskImage || "").toBe("");
    expect(readStyle(idle.scroller).WebkitMaskImage || "").toBe("");
    expect(idle.scroller.style.paddingBottom).toBe("24px");
  });

  it("dissolves from transparent at the edge to opaque at the fade height", () => {
    const gradient = /^linear-gradient\(to bottom, transparent 0, black (\d+)px\)$/.exec(
      CHAT_TRANSCRIPT_FADE_MASK_IMAGE,
    );
    expect(gradient).not.toBeNull();
    expect(Number(gradient?.[1])).toBe(CHAT_TRANSCRIPT_FADE_PX);
    // Clears the pill (8px top padding + a ~30px pill) without reaching into
    // the second line of the first bubble.
    expect(CHAT_TRANSCRIPT_FADE_PX).toBeGreaterThanOrEqual(38);
    expect(CHAT_TRANSCRIPT_FADE_PX).toBeLessThanOrEqual(48);
  });

  it("keeps the pill's fade-in/out and hands out the refs the sticky line reads", async () => {
    const shown = await renderViewport(assistantSpeaker);
    expect(shown.overlayRef.current).toBe(shown.overlay);
    expect(shown.scrollContainerRef.current).toBe(shown.scroller);
    expect(shown.overlay.getAttribute("aria-hidden")).toBeNull();
    expect((shown.overlay.firstElementChild as HTMLElement).className).toContain("opacity-100");

    const human = await renderViewport(humanSpeaker);
    expect(human.overlay.querySelector('[data-testid="chat-human-speaker-pill"]')?.textContent).toContain(
      "Taylor",
    );

    const hidden = await renderViewport(null);
    expect(hidden.overlay.getAttribute("aria-hidden")).toBe("true");
    expect((hidden.overlay.firstElementChild as HTMLElement).className).toContain("opacity-0");
    expect(hidden.overlay.textContent).toBe("");
  });
});
