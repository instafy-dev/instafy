// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useContinuousVoiceSession } from "../useContinuousVoiceSession";

type HarnessValue = ReturnType<typeof useContinuousVoiceSession>;

function Harness(props: { onValue: (value: HarnessValue) => void }) {
  const value = useContinuousVoiceSession();
  props.onValue(value);
  return null;
}

describe("useContinuousVoiceSession", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("tracks turn start and awaiting-assistant transitions", async () => {
    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    await act(async () => {
      latestValue?.markTurnStarted();
    });

    expect(latestValue?.continuousConversationActive).toBe(true);
    expect(latestValue?.continuousAwaitingAssistantReply).toBe(false);
    expect(latestValue?.continuousPauseMessage).toBeNull();

    await act(async () => {
      latestValue?.markAwaitingAssistantReply("assistant-1");
    });

    expect(latestValue?.continuousAwaitingAssistantReply).toBe(true);

    let consumed = false;
    await act(async () => {
      consumed = latestValue?.consumeAssistantReplyIfReady("assistant-2") ?? false;
    });

    expect(consumed).toBe(true);
    expect(latestValue?.continuousAwaitingAssistantReply).toBe(false);
    expect(latestValue?.continuousConversationActive).toBe(true);
  });

  it("pauses with optional foreground resume", async () => {
    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    await act(async () => {
      latestValue?.markTurnStarted();
      latestValue?.markAwaitingAssistantReply("assistant-1");
      latestValue?.pause("Paused in background.", {
        resumeOnForeground: true,
      });
    });

    expect(latestValue?.continuousConversationActive).toBe(false);
    expect(latestValue?.continuousAwaitingAssistantReply).toBe(false);
    expect(latestValue?.continuousPauseMessage).toBe("Paused in background.");
    expect(latestValue?.shouldResumeOnForeground()).toBe(true);

    await act(async () => {
      latestValue?.clearForegroundResume();
      latestValue?.clearPauseMessage();
    });

    expect(latestValue?.shouldResumeOnForeground()).toBe(false);
    expect(latestValue?.continuousPauseMessage).toBeNull();
  });

  it("resets and handles failed starts", async () => {
    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    await act(async () => {
      latestValue?.markTurnStarted();
      latestValue?.markAwaitingAssistantReply("assistant-1");
      latestValue?.markTurnStartFailed();
    });

    expect(latestValue?.continuousConversationActive).toBe(false);
    expect(latestValue?.continuousAwaitingAssistantReply).toBe(false);

    await act(async () => {
      latestValue?.pause("Voice paused.");
      latestValue?.reset();
    });

    expect(latestValue?.continuousConversationActive).toBe(false);
    expect(latestValue?.continuousAwaitingAssistantReply).toBe(false);
    expect(latestValue?.continuousPauseMessage).toBeNull();
    expect(latestValue?.shouldResumeOnForeground()).toBe(false);
  });
});
