// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAudioSessionState } from "../../audio/hostAudioSessionState";
import { useContinuousVoiceSession } from "../useContinuousVoiceSession";
import { useVoiceConversationLoop } from "../useVoiceConversationLoop";

type HarnessProps = {
  voiceInteractionMode?: "hold" | "tap" | "continuous";
  busy?: boolean;
  voiceSupported?: boolean;
  useHostedVoiceCapture?: boolean;
  voiceCapture?: "hosted" | "device";
  voiceStarting?: boolean;
  voiceListening?: boolean;
  voiceTranscribing?: boolean;
  voiceCompletedTranscript?: string;
  voiceError?: string | null;
  latestAssistantId?: string | null;
  replyPlaybackSpeaking?: boolean;
  hostAudioSession?: HostAudioSessionState | null;
  onSubmitTranscript?: (transcript: string) => Promise<boolean>;
  onTranscriptResolved?: (transcript: string) => void;
  startVoiceTurn?: () => Promise<boolean>;
  stopVoiceTurn?: () => Promise<string>;
  cancelVoiceTurn?: () => void;
  clearVoiceTurnTranscript?: () => void;
  onStatusChange?: (message: string) => void;
  showStatus?: (message: string, intent?: string, durationMs?: number) => void;
  onValue: (value: HarnessValue) => void;
};

type HarnessValue = {
  session: ReturnType<typeof useContinuousVoiceSession>;
  loop: ReturnType<typeof useVoiceConversationLoop>;
};

const DEFAULT_HOST_AUDIO_SESSION: HostAudioSessionState = {
  phase: "idle",
  foreground: true,
  focused: true,
  audioSessionActive: false,
  voiceCaptureActive: false,
  interrupted: false,
  interruptionReason: null,
  routeChangeReason: null,
  routeKind: "speaker",
  preferredOutputLabel: null,
  microphonePermission: "granted",
  captureReady: true,
  playbackReady: true,
  recommendedPlaybackRoute: "speaker",
  routeHint: "Phone speaker route is active.",
  warnings: [],
};

function Harness(props: HarnessProps) {
  const session = useContinuousVoiceSession();
  const loop = useVoiceConversationLoop({
    continuousSession: session,
    voiceInteractionMode: props.voiceInteractionMode ?? "continuous",
    debugScope: "chatComposer",
    voiceSupported: props.voiceSupported ?? true,
    voiceCapture: props.voiceCapture ?? "hosted",
    useHostedVoiceCapture: props.useHostedVoiceCapture ?? true,
    voiceStarting: props.voiceStarting ?? false,
    voiceListening: props.voiceListening ?? false,
    voiceTranscribing: props.voiceTranscribing ?? false,
    voiceCompletedTranscript: props.voiceCompletedTranscript ?? "",
    voiceError: props.voiceError ?? null,
    busy: props.busy ?? false,
    latestAssistantId: props.latestAssistantId ?? null,
    replyPlaybackSpeaking: props.replyPlaybackSpeaking ?? false,
    hostAudioSession: props.hostAudioSession ?? DEFAULT_HOST_AUDIO_SESSION,
    startVoiceTurn: async () => props.startVoiceTurn?.() ?? true,
    stopVoiceTurn: async () => props.stopVoiceTurn?.() ?? "",
    cancelVoiceTurn: props.cancelVoiceTurn ?? (() => {}),
    clearVoiceTurnTranscript: props.clearVoiceTurnTranscript ?? (() => {}),
    onSubmitTranscript:
      props.onSubmitTranscript ?? (async () => true),
    onTranscriptResolved: props.onTranscriptResolved,
    onStatusChange: props.onStatusChange ?? (() => {}),
    showStatus:
      (props.showStatus as HarnessProps["showStatus"]) ??
      (() => {}),
    pressStartStatusText: "Listening…",
    continuousStartStatusText: "Continuous listening…",
    hostedPressEndStatusText: "Transcribing your voice…",
    devicePressEndStatusText: "Finishing the transcript…",
    stopAfterCurrentTurnStatusText: "Finishing the current voice turn…",
    continuousStoppedStatusText: "Continuous voice stopped.",
  });
  props.onValue({ session, loop });
  return null;
}

describe("useVoiceConversationLoop", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;
  let latestProps: HarnessProps;

  const renderHarness = async (overrides: Partial<HarnessProps> = {}) => {
    latestProps = {
      ...latestProps,
      ...overrides,
    };
    await act(async () => {
      root.render(<Harness {...latestProps} />);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    latestProps = {
      onValue: (value) => {
        latestValue = value;
      },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("auto-submits a completed transcript once and marks awaiting-assistant state", async () => {
    const onSubmitTranscript = vi.fn(async () => true);
    const clearVoiceTurnTranscript = vi.fn();

    await renderHarness({
      onSubmitTranscript,
      clearVoiceTurnTranscript,
    });

    await act(async () => {
      latestValue?.session.markTurnStarted();
    });

    await renderHarness({
      onSubmitTranscript,
      clearVoiceTurnTranscript,
      voiceCompletedTranscript: "hello there",
      latestAssistantId: "assistant-1",
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmitTranscript).toHaveBeenCalledTimes(1);
    expect(onSubmitTranscript).toHaveBeenCalledWith("hello there");
    expect(clearVoiceTurnTranscript).toHaveBeenCalledTimes(1);
    expect(latestValue?.session.continuousAwaitingAssistantReply).toBe(true);

    await renderHarness({
      onSubmitTranscript,
      clearVoiceTurnTranscript,
      voiceCompletedTranscript: "hello there",
      latestAssistantId: "assistant-1",
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmitTranscript).toHaveBeenCalledTimes(1);
  });

  it("restarts after a new assistant reply arrives", async () => {
    const startVoiceTurn = vi.fn(async () => true);

    await renderHarness({
      startVoiceTurn,
    });

    await act(async () => {
      latestValue?.session.markTurnStarted();
      latestValue?.session.markAwaitingAssistantReply("assistant-1");
    });

    await renderHarness({
      startVoiceTurn,
      latestAssistantId: "assistant-2",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(latestValue?.session.continuousConversationActive).toBe(true);
  });

  it("pauses when the assistant reply times out", async () => {
    const onStatusChange = vi.fn();

    await renderHarness({
      onStatusChange,
    });

    await act(async () => {
      latestValue?.session.markTurnStarted();
      latestValue?.session.markAwaitingAssistantReply("assistant-1");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(latestValue?.session.continuousConversationActive).toBe(false);
    expect(latestValue?.session.continuousAwaitingAssistantReply).toBe(false);
    expect(latestValue?.session.continuousPauseMessage).toContain("Assistant reply took too long");
    expect(onStatusChange).toHaveBeenCalledWith(
      "Assistant reply took too long. Continuous voice paused. Tap once to resume.",
    );
  });

  it("pauses on benign no-speech and hard errors after an active turn", async () => {
    const onStatusChange = vi.fn();

    await renderHarness({
      onStatusChange,
    });

    await act(async () => {
      latestValue?.session.markTurnStarted();
    });

    await renderHarness({
      onStatusChange,
      voiceError: "No speech detected. Please try again.",
    });

    expect(latestValue?.session.continuousPauseMessage).toBe(
      "No speech detected. Continuous voice paused. Tap once to resume.",
    );

    await renderHarness({
      onStatusChange,
      voiceError: null,
    });

    await act(async () => {
      latestValue?.session.markTurnStarted();
    });

    await renderHarness({
      onStatusChange,
      voiceError: "Microphone disconnected",
    });

    expect(latestValue?.session.continuousPauseMessage).toBe(
      "Microphone disconnected Tap once to resume continuous voice.",
    );
  });

  it("restarts after a foreground resume request", async () => {
    const startVoiceTurn = vi.fn(async () => true);
    const showStatus = vi.fn();
    const onStatusChange = vi.fn();

    await renderHarness({
      startVoiceTurn,
      showStatus,
      onStatusChange,
    });

    await act(async () => {
      latestValue?.session.pause("Paused in background.", {
        resumeOnForeground: true,
      });
    });

    await renderHarness({
      startVoiceTurn,
      showStatus,
      onStatusChange,
      hostAudioSession: {
        ...DEFAULT_HOST_AUDIO_SESSION,
        foreground: true,
        focused: true,
        phase: "idle",
      },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(showStatus).toHaveBeenCalledWith(
      "Instafy is active again. Restarting continuous voice…",
      "info",
      2500,
    );
    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
  });
});
