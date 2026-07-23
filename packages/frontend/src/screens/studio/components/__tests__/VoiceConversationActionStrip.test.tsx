// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceConversationActionStrip } from "../VoiceConversationActionStrip";

const PointerEventCtor =
  typeof globalThis.PointerEvent === "function" ? globalThis.PointerEvent : MouseEvent;

describe("VoiceConversationActionStrip", () => {
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

  it("wires the reply toggle and hold-to-talk events", async () => {
    const onToggleVoiceReplies = vi.fn();
    const onVoicePressStart = vi.fn();
    const onVoicePressEnd = vi.fn();
    const onPointerCaptureStart = vi.fn();
    const onPointerCaptureEnd = vi.fn();

    await act(async () => {
      root.render(
        <VoiceConversationActionStrip
          showVoiceRepliesToggle
          voiceRepliesEnabled={false}
          replySpeaking={false}
          onToggleVoiceReplies={onToggleVoiceReplies}
          voiceActionActive={false}
          voiceListening={false}
          voiceStarting={false}
          voiceTranscribing={false}
          voiceState="idle"
          voiceRoute="provider"
          voiceCapture="hosted"
          disabled={false}
          onVoicePressStart={onVoicePressStart}
          onVoicePressEnd={onVoicePressEnd}
          onPointerCaptureStart={onPointerCaptureStart}
          onPointerCaptureEnd={onPointerCaptureEnd}
          primaryActionClassName="primary"
          outlinedActionClassName="outline"
          actionIconClassName="icon"
        />,
      );
    });

    const repliesToggle = container.querySelector(
      '[data-testid="chat-voice-replies-toggle"]',
    ) as HTMLButtonElement | null;
    const voiceButton = container.querySelector(
      '[data-testid="chat-voice-input-button"]',
    ) as HTMLButtonElement | null;

    expect(repliesToggle).not.toBeNull();
    expect(voiceButton).not.toBeNull();
    expect(voiceButton?.getAttribute("data-voice-route")).toBe("provider");
    expect(voiceButton?.getAttribute("data-voice-capture")).toBe("hosted");

    await act(async () => {
      repliesToggle?.click();
    });
    expect(onToggleVoiceReplies).toHaveBeenCalledTimes(1);

    await act(async () => {
      voiceButton?.dispatchEvent(
        new PointerEventCtor("pointerdown", {
          bubbles: true,
          button: 0,
        }),
      );
      voiceButton?.dispatchEvent(
        new PointerEventCtor("pointerup", {
          bubbles: true,
          button: 0,
        }),
      );
    });

    expect(onPointerCaptureStart).toHaveBeenCalledTimes(1);
    expect(onPointerCaptureEnd).toHaveBeenCalledTimes(1);
    expect(onVoicePressStart).toHaveBeenCalledTimes(1);
    expect(onVoicePressEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      voiceButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      voiceButton?.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    });

    expect(onVoicePressStart).toHaveBeenCalledTimes(2);
    expect(onVoicePressEnd).toHaveBeenCalledTimes(2);
  });

  it("uses click-to-toggle in tap mode", async () => {
    const onVoiceTap = vi.fn();
    const onVoicePressStart = vi.fn();
    const onVoicePressEnd = vi.fn();

    await act(async () => {
      root.render(
        <VoiceConversationActionStrip
          showVoiceRepliesToggle={false}
          voiceRepliesEnabled={false}
          replySpeaking={false}
          onToggleVoiceReplies={() => {}}
          voiceActionActive={false}
          voiceListening={false}
          voiceStarting={false}
          voiceTranscribing={false}
          voiceState="idle"
          voiceRoute="provider"
          voiceCapture="hosted"
          voiceInteractionMode="tap"
          disabled={false}
          onVoicePressStart={onVoicePressStart}
          onVoicePressEnd={onVoicePressEnd}
          onVoiceTap={onVoiceTap}
          primaryActionClassName="primary"
          outlinedActionClassName="outline"
          actionIconClassName="icon"
        />,
      );
    });

    const voiceButton = container.querySelector(
      '[data-testid="chat-voice-input-button"]',
    ) as HTMLButtonElement | null;

    expect(voiceButton?.getAttribute("aria-label")).toBe("Tap to talk");

    await act(async () => {
      voiceButton?.click();
    });

    expect(onVoiceTap).toHaveBeenCalledTimes(1);
    expect(onVoicePressStart).not.toHaveBeenCalled();
    expect(onVoicePressEnd).not.toHaveBeenCalled();
  });

  it("exposes a continuous conversation label in continuous mode", async () => {
    const onVoiceTap = vi.fn();

    await act(async () => {
      root.render(
        <VoiceConversationActionStrip
          showVoiceRepliesToggle={false}
          voiceRepliesEnabled={false}
          replySpeaking={false}
          onToggleVoiceReplies={() => {}}
          voiceActionActive={false}
          voiceListening={false}
          voiceStarting={false}
          voiceTranscribing={false}
          voiceState="idle"
          voiceRoute="provider"
          voiceCapture="hosted"
          voiceInteractionMode="continuous"
          disabled={false}
          onVoicePressStart={() => {}}
          onVoicePressEnd={() => {}}
          onVoiceTap={onVoiceTap}
          primaryActionClassName="primary"
          outlinedActionClassName="outline"
          actionIconClassName="icon"
        />,
      );
    });

    const voiceButton = container.querySelector(
      '[data-testid="chat-voice-input-button"]',
    ) as HTMLButtonElement | null;

    expect(voiceButton?.getAttribute("aria-label")).toBe(
      "Tap to start continuous voice conversation",
    );

    await act(async () => {
      voiceButton?.click();
    });

    expect(onVoiceTap).toHaveBeenCalledTimes(1);
  });
});
