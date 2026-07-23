import { describe, expect, it } from "vitest";
import {
  deriveVoiceTurnRecoveryNotice,
  type VoiceTurnRecoveryNotice,
} from "../useVoiceTurnRecovery";
import type { HostAudioSessionState } from "../../audio/hostAudioSessionState";

function createSession(overrides?: Partial<HostAudioSessionState>): HostAudioSessionState {
  return {
    phase: "idle",
    foreground: true,
    focused: true,
    audioSessionActive: false,
    voiceCaptureActive: false,
    interrupted: false,
    interruptionReason: null,
    routeChangeReason: null,
    routeKind: "bluetooth",
    preferredOutputLabel: "Marcus’s AirPods Pro",
    microphonePermission: "granted",
    captureReady: true,
    playbackReady: true,
    recommendedPlaybackRoute: "bluetooth",
    routeHint: "Likely headset route: Marcus’s AirPods Pro",
    warnings: [],
    ...overrides,
  };
}

function expectNoticeKind(value: VoiceTurnRecoveryNotice | null, kind: VoiceTurnRecoveryNotice["kind"]) {
  expect(value).not.toBeNull();
  expect(value?.kind).toBe(kind);
}

describe("useVoiceTurnRecovery helpers", () => {
  it("cancels and warns when an interruption begins during an active voice turn", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        interrupted: true,
        interruptionReason: "system interruption began",
      }),
      voiceState: "listening",
    });

    expectNoticeKind(notice, "interrupt_start");
    expect(notice?.cancelActiveTurn).toBe(true);
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("Hold to talk again");
  });

  it("uses tap wording when a tap interaction is interrupted", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        interrupted: true,
        interruptionReason: "system interruption began",
      }),
      voiceState: "listening",
      interactionMode: "tap",
    });

    expectNoticeKind(notice, "interrupt_start");
    expect(notice?.message).toContain("Tap to talk again");
  });

  it("uses continuous wording when a continuous loop is interrupted", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        interrupted: true,
        interruptionReason: "system interruption began",
      }),
      voiceState: "listening",
      interactionMode: "continuous",
    });

    expectNoticeKind(notice, "interrupt_start");
    expect(notice?.message).toContain("Tap once to resume continuous voice");
  });

  it("announces when an interruption ends", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession({
        interrupted: true,
        interruptionReason: "system interruption began",
      }),
      currentSession: createSession(),
      voiceState: "idle",
    });

    expectNoticeKind(notice, "interrupt_end");
    expect(notice?.cancelActiveTurn).toBe(false);
    expect(notice?.tone).toBe("info");
  });

  it("warns when Instafy moves to the background during a continuous loop", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        phase: "background",
        foreground: false,
        focused: false,
      }),
      voiceState: "listening",
      interactionMode: "continuous",
    });

    expectNoticeKind(notice, "background_pause");
    expect(notice?.cancelActiveTurn).toBe(true);
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("will resume when the app is active again");
  });

  it("uses manual resume wording for non-continuous background pauses", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        phase: "background",
        foreground: false,
        focused: false,
      }),
      voiceState: "starting",
      interactionMode: "tap",
    });

    expectNoticeKind(notice, "background_pause");
    expect(notice?.message).toContain("tap to talk again");
  });

  it("does not warn on normal tab backgrounding when manual voice is idle", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        phase: "background",
        foreground: false,
        focused: false,
      }),
      voiceState: "idle",
      interactionMode: "hold",
    });

    expect(notice).toBeNull();
  });

  it("keeps route-change guidance continuous-aware", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        routeKind: "receiver",
        preferredOutputLabel: "iPhone Receiver",
        routeChangeReason: "route override",
        recommendedPlaybackRoute: "speaker",
        routeHint: "Phone earpiece route: iPhone Receiver",
      }),
      voiceState: "starting",
      interactionMode: "continuous",
    });

    expectNoticeKind(notice, "route_change");
    expect(notice?.message).toContain("tap once to resume continuous voice");
  });

  it("warns when the route changes to the phone earpiece", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession(),
      currentSession: createSession({
        routeKind: "receiver",
        preferredOutputLabel: "iPhone Receiver",
        routeChangeReason: "route override",
        recommendedPlaybackRoute: "speaker",
        routeHint: "Phone earpiece route: iPhone Receiver",
      }),
      voiceState: "starting",
    });

    expectNoticeKind(notice, "route_change");
    expect(notice?.cancelActiveTurn).toBe(true);
    expect(notice?.message).toContain("phone earpiece");
  });

  it("announces when the route switches back to bluetooth", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession({
        routeKind: "speaker",
        preferredOutputLabel: "iPhone Speaker",
        routeChangeReason: "old device unavailable",
        recommendedPlaybackRoute: "speaker",
        routeHint: "Phone speaker route: iPhone Speaker",
      }),
      currentSession: createSession({
        routeKind: "bluetooth",
        preferredOutputLabel: "Marcus’s AirPods Pro",
        routeChangeReason: "new device available",
      }),
      voiceState: "starting",
    });

    expectNoticeKind(notice, "route_change");
    expect(notice?.cancelActiveTurn).toBe(false);
    expect(notice?.tone).toBe("info");
    expect(notice?.message).toContain("Marcus’s AirPods Pro");
  });

  it("ignores route hydration while manual voice is idle", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession({
        routeKind: "speaker",
        preferredOutputLabel: "Phone Speaker",
        routeChangeReason: null,
      }),
      currentSession: createSession({
        routeKind: "receiver",
        preferredOutputLabel: "Phone Earpiece",
        routeChangeReason: "route configuration changed",
      }),
      voiceState: "idle",
      interactionMode: "hold",
    });

    expect(notice).toBeNull();
  });

  it("ignores route hydration when continuous is selected but no session is active", () => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: createSession({ routeKind: "speaker" }),
      currentSession: createSession({
        routeKind: "receiver",
        preferredOutputLabel: "Phone Earpiece",
        routeChangeReason: "route configuration changed",
      }),
      voiceState: "idle",
      interactionMode: "continuous",
      continuousSessionActive: false,
    });

    expect(notice).toBeNull();
  });
});
