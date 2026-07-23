// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSpeechReplyUnavailableMessage,
  selectSpeechReplyBackendPreference,
  useSpeechReplyPlayback,
  type SpeechReplyMessage,
} from "../useSpeechReplyPlayback";

const { speakTextWithSpeechServiceMock } = vi.hoisted(() => ({
  speakTextWithSpeechServiceMock: vi.fn(),
}));

vi.mock("../speechService", () => ({
  readSpeechPlaybackDebugSnapshot: () => ({
    stage: "idle",
    detail: null,
    sourceKind: null,
    via: null,
    updatedAt: null,
  }),
  speakTextWithSpeechService: speakTextWithSpeechServiceMock,
  subscribeSpeechPlaybackDebug: () => () => {},
}));

type HarnessValue = ReturnType<typeof useSpeechReplyPlayback>;

function Harness(props: {
  enabled: boolean;
  latestReply?: SpeechReplyMessage;
  onValue: (value: HarnessValue) => void;
  onError?: (message: string) => void;
}) {
  const value = useSpeechReplyPlayback({
    enabled: props.enabled,
    latestReply: props.latestReply,
    backendPreference: "provider",
    onError: props.onError,
  });
  props.onValue(value);
  return null;
}

describe("useSpeechReplyPlayback", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    speakTextWithSpeechServiceMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("maps device reply playback to the browser backend", () => {
    expect(selectSpeechReplyBackendPreference("device")).toBe("browser");
    expect(selectSpeechReplyBackendPreference("provider")).toBe("provider");
  });

  it("auto-speaks the latest assistant reply once per message id", async () => {
    speakTextWithSpeechServiceMock.mockResolvedValue({
      spoken: true,
      backend: "provider",
      label: "Speech provider",
    });

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{ id: "assistant-1", content: "Hello from the assistant" }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(speakTextWithSpeechServiceMock).toHaveBeenCalledTimes(1);
    expect(speakTextWithSpeechServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from the assistant",
        backendPreference: "provider",
      }),
    );

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{ id: "assistant-1", content: "Hello from the assistant" }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(speakTextWithSpeechServiceMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{ id: "assistant-2", content: "A fresh reply" }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(speakTextWithSpeechServiceMock).toHaveBeenCalledTimes(2);
    expect(latestValue?.lastBackendLabel).toBe("Speech provider");
  });

  it("does not replay the same logical reply when the message id changes but playback key stays stable", async () => {
    speakTextWithSpeechServiceMock.mockResolvedValue({
      spoken: true,
      backend: "provider",
      label: "Speech provider",
    });

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{
            id: "assistant-1",
            playbackKey: "job-1",
            content: "Same logical assistant reply",
          }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(speakTextWithSpeechServiceMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{
            id: "assistant-2",
            playbackKey: "job-1",
            content: "Same logical assistant reply",
          }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(speakTextWithSpeechServiceMock).toHaveBeenCalledTimes(1);
  });

  it("reports an error when no speech backend can play the reply", async () => {
    const onError = vi.fn();
    speakTextWithSpeechServiceMock.mockResolvedValue({
      spoken: false,
      backend: "none",
      label: null,
    });

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{ id: "assistant-1", content: "No backend available" }}
          onError={onError}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(buildSpeechReplyUnavailableMessage());
    expect(latestValue?.lastError).toBe(buildSpeechReplyUnavailableMessage());
  });

  it("tracks the speaking lifecycle and spoken reply id for successful playback", async () => {
    let resolvePlayback: ((value: { spoken: boolean; backend: "provider"; label: string }) => void) | null = null;
    speakTextWithSpeechServiceMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePlayback = resolve;
        }),
    );

    await act(async () => {
      root.render(
        <Harness
          enabled
          latestReply={{ id: "assistant-speaking-1", content: "Speaking reply" }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latestValue?.speaking).toBe(true);
    expect(latestValue?.lastAttemptedReplyId).toBe("assistant-speaking-1");
    expect(latestValue?.lastSpokenReplyId).toBeNull();

    await act(async () => {
      resolvePlayback?.({
        spoken: true,
        backend: "provider",
        label: "Speech provider",
      });
      await Promise.resolve();
    });

    expect(latestValue?.speaking).toBe(false);
    expect(latestValue?.lastSpokenReplyId).toBe("assistant-speaking-1");
    expect(latestValue?.lastBackendLabel).toBe("Speech provider");
  });
});
