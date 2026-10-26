// Device driver for knosh.voice_scenario.v1 files — the SAME scenario JSON
// the knosh repo's simulator gate (tools/learning/run_voice_scenario) and
// Unity twin playback consume. Here the events drive the REAL app: user
// speech is injected into the hosted voice-capture test seam (no mic/STT),
// the actual conversation loop responds, and sleep/wake play the contract
// robot behaviors through the embodied executor. A window API
// (__KNOSH_VOICE_SCENARIO__) exposes it to automation (Playwright smokes,
// adb-driven scripts, or a human in devtools), so identical scripts validate
// the virtual board, the twin, and the phone.

export const VOICE_SCENARIO_SCHEMA = "knosh.voice_scenario.v1";
export const DEVICE_RESULT_SCHEMA = "knosh.voice_scenario_device_result.v1";

export type VoiceScenarioEvent = {
  at_s: number;
  kind: "user_speech" | "thinking" | "reply_speech" | "sleep" | "camera_capture";
  text?: string;
  direction_deg?: number;
  duration_s?: number;
  audio_path?: string;
  /** camera_capture: the visual question the user poses while showing an object. */
  question?: string;
  /**
   * camera_capture, SIM-ONLY input: the simulator gate feeds this image to its
   * synthetic camera. The device driver accepts the field for scenario parity
   * but NEVER resolves or opens it — on device the real camera (or its test
   * seam) supplies the pixels.
   */
  fixture_image?: string;
  /** camera_capture: fail the event if the classified label differs (case-insensitive). */
  expected_label?: string;
  /**
   * camera_capture: maximum allowed CLASSIFIER latency, asserted against the
   * consumed observation's latencyMs (simulator-gate parity). This is NOT the
   * observation-window timeout — duration_s (default 5s) is the window.
   */
  max_latency_s?: number;
};

/**
 * Mirror of the camera observation-bus record published by
 * src/camera/visionClassifier (knosh.vision_classify_response.v1, camelCase,
 * plus the bus timestamp). The driver only READS these — it never invokes
 * capture or classification itself.
 */
export type VisionObservation = {
  atMs: number;
  question: string;
  label: string;
  answer: string;
  latencyMs: number;
};

export type VoiceScenario = {
  schema: string;
  name: string;
  description?: string;
  end_s: number;
  timeline: VoiceScenarioEvent[];
};

export type VoiceScenarioDeviceHooks = {
  /** Arm the hosted voice-capture test seam with a transcript. */
  configureTranscript: (text: string) => void;
  /** Begin a voice turn (as if the user tapped the mic). */
  startTurn: () => void | Promise<void>;
  /** End the voice turn; the transcript auto-submits downstream. */
  stopTurn: () => void | Promise<void>;
  /** Run a robot capability prompt (drives the embodied behaviors). */
  executePrompt: (prompt: string) => void | Promise<void>;
  /** Whether reply audio is currently playing (speaking face state). */
  isSpeaking: () => boolean;
  /**
   * Latest record from the vision observation bus (null before any). During a
   * camera_capture window the driver POLLS this — it issues no commands and
   * calls no classifier; the camera-observation capability does the work.
   */
  getLatestVisionObservation: () => VisionObservation | null;
  /** Injectable clock for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export type VoiceScenarioDeviceEventVision = {
  question: string;
  label: string;
  answer: string;
  latency_ms: number;
  expected_label?: string;
  matched: boolean;
};

export type VoiceScenarioDeviceEventResult = {
  at_s: number;
  kind: string;
  detail: string;
  ok: boolean;
  vision?: VoiceScenarioDeviceEventVision;
};

export type VoiceScenarioDeviceResult = {
  schema: typeof DEVICE_RESULT_SCHEMA;
  scenario: string;
  events: VoiceScenarioDeviceEventResult[];
  observed_reply_speech: boolean;
  observed_vision: boolean;
  result: { success: boolean; failures: string[] };
};

export function validateVoiceScenario(raw: unknown): VoiceScenario {
  const scenario = raw as VoiceScenario;
  if (!scenario || scenario.schema !== VOICE_SCENARIO_SCHEMA) {
    throw new Error(`Expected schema ${VOICE_SCENARIO_SCHEMA}.`);
  }
  if (!scenario.name || !/^[a-z0-9_]+$/.test(scenario.name)) {
    throw new Error("Scenario needs a snake_case name.");
  }
  if (!Array.isArray(scenario.timeline) || scenario.timeline.length === 0) {
    throw new Error("Scenario needs a non-empty timeline.");
  }
  if (!Number.isFinite(scenario.end_s) || scenario.end_s <= 0) {
    throw new Error("Scenario needs a positive end_s.");
  }
  let previousAt = -1;
  let sawCameraCapture = false;
  for (const [index, event] of scenario.timeline.entries()) {
    if (
      !["user_speech", "thinking", "reply_speech", "sleep", "camera_capture"].includes(
        event.kind,
      )
    ) {
      throw new Error(`timeline[${index}]: unknown kind '${event.kind}'.`);
    }
    if (!Number.isFinite(event.at_s) || event.at_s < previousAt) {
      throw new Error(`timeline[${index}]: events must be sorted by at_s.`);
    }
    previousAt = event.at_s;
    if (event.kind === "user_speech" && !event.text && !event.audio_path) {
      throw new Error(`timeline[${index}]: user_speech needs text (or audio_path).`);
    }
    if (event.kind === "camera_capture") {
      if (typeof event.question !== "string" || event.question.trim().length === 0) {
        throw new Error(`timeline[${index}]: camera_capture needs a question.`);
      }
      // fixture_image is accepted for scenario parity with the simulator gate
      // but is deliberately NOT validated, resolved, or opened here.
      sawCameraCapture = true;
    }
    if (
      event.kind === "reply_speech" &&
      typeof event.text === "string" &&
      event.text.includes("{label}") &&
      !sawCameraCapture
    ) {
      throw new Error(
        `timeline[${index}]: {label} in reply_speech requires an earlier camera_capture.`,
      );
    }
  }
  return scenario;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plays a scenario against the live app. Timing note: unlike the simulator
 * gate (which asserts board telemetry), the device run drives the real
 * conversation loop — replies arrive when the assistant answers, so
 * reply_speech events are OBSERVATION WINDOWS (did reply audio play?)
 * rather than commands.
 */
export async function runVoiceScenarioOnDevice(
  raw: unknown,
  hooks: VoiceScenarioDeviceHooks,
): Promise<VoiceScenarioDeviceResult> {
  const scenario = validateVoiceScenario(raw);
  const wait = hooks.sleep ?? defaultSleep;
  // Vision consumption cursor (device-pipeline timing rationale): a fast
  // local capture/classify pipeline triggered by the preceding user_speech
  // often publishes its observation BETWEEN stopTurn and the camera_capture
  // event opening its window. Gating acceptance on the window-open timestamp
  // would permanently reject exactly those observations and time the event
  // out despite correct behavior. Instead, a camera_capture accepts the
  // latest observation when it was recorded after the RUN started AND after
  // the last observation consumed by an earlier camera_capture. Consuming
  // advances the cursor, so multiple captures can never double-count a
  // single observation.
  const runStartMs = Date.now();
  let lastConsumedObservationAtMs = Number.NEGATIVE_INFINITY;
  const events: VoiceScenarioDeviceEventResult[] = [];
  const failures: string[] = [];
  let observedReplySpeech = false;
  let observedVision = false;
  let asleep = false;
  let clockS = 0;
  /** Label from the most recent camera_capture; substituted into later
   *  {label} detail strings (observational only — it never alters commands). */
  let lastLabel: string | null = null;
  const substituteLabel = (text: string) =>
    lastLabel === null ? text : text.split("{label}").join(lastLabel);

  const advanceTo = async (targetS: number) => {
    if (targetS > clockS) {
      await wait((targetS - clockS) * 1000);
      clockS = targetS;
    }
  };

  for (const event of scenario.timeline) {
    await advanceTo(event.at_s);
    try {
      switch (event.kind) {
        case "user_speech": {
          if (asleep) {
            await hooks.executePrompt("wake up");
            asleep = false;
          }
          hooks.configureTranscript(event.text ?? "");
          await hooks.startTurn();
          const holdS = Math.max(0.2, event.duration_s ?? 1);
          await wait(holdS * 1000);
          clockS += holdS;
          await hooks.stopTurn();
          events.push({
            at_s: event.at_s,
            kind: event.kind,
            detail: event.text ?? "",
            ok: true,
          });
          break;
        }
        case "sleep": {
          await hooks.executePrompt("go to sleep");
          asleep = true;
          events.push({ at_s: event.at_s, kind: event.kind, detail: "stow", ok: true });
          break;
        }
        case "reply_speech":
        case "thinking": {
          const holdS = Math.max(0.2, event.duration_s ?? 1);
          const sampleMs = 200;
          let sawSpeaking = false;
          for (let elapsed = 0; elapsed < holdS * 1000; elapsed += sampleMs) {
            await wait(sampleMs);
            if (hooks.isSpeaking()) {
              sawSpeaking = true;
            }
          }
          clockS += holdS;
          if (event.kind === "reply_speech") {
            observedReplySpeech = observedReplySpeech || sawSpeaking;
          }
          const replyText = substituteLabel(event.text ?? "");
          events.push({
            at_s: event.at_s,
            kind: event.kind,
            detail:
              event.kind === "reply_speech"
                ? replyText
                  ? `${replyText} (speaking observed: ${sawSpeaking})`
                  : `speaking observed: ${sawSpeaking}`
                : "",
            ok: true,
          });
          break;
        }
        case "camera_capture": {
          // Sim/device parity rules (mirror the simulator gate contract):
          //  - fixture_image is SIM-ONLY input; the device never resolves or
          //    opens it — the real camera path (or its test seam) supplies
          //    pixels via the camera-observation capability.
          //  - This is an OBSERVATION window: the driver issues NO robot
          //    commands and calls NO classifier. The head holds gaze
          //    naturally (the sim gate asserts yaw-hold; on device the
          //    analogue is behavioral, not commanded).
          //  - Capture while stowed is a failure — no auto-wake.
          if (asleep) {
            throw new Error("camera_capture while stowed");
          }
          // Sim-gate semantics: duration_s is the observation window;
          // max_latency_s asserts the classifier latency of the consumed
          // observation, never the window length.
          const windowS = event.duration_s ?? 5;
          const sampleMs = 200;
          let observation: VisionObservation | null = null;
          let elapsedMs = 0;
          for (;;) {
            const latest = hooks.getLatestVisionObservation();
            // Consumption-cursor acceptance (see runStartMs rationale above):
            // pre-window observations from the triggering user_speech are
            // admitted, pre-run and already-consumed observations are not.
            if (
              latest &&
              latest.atMs >= runStartMs &&
              latest.atMs > lastConsumedObservationAtMs
            ) {
              observation = latest;
              lastConsumedObservationAtMs = latest.atMs;
              break;
            }
            if (elapsedMs >= windowS * 1000) {
              break;
            }
            await wait(sampleMs);
            elapsedMs += sampleMs;
          }
          clockS += elapsedMs / 1000;
          if (!observation) {
            throw new Error(
              `no vision observation within ${windowS}s for question '${event.question}'`,
            );
          }
          observedVision = true;
          lastLabel = observation.label;
          const matched = event.expected_label
            ? observation.label.toLowerCase() === event.expected_label.toLowerCase()
            : true;
          const vision: VoiceScenarioDeviceEventVision = {
            question: event.question ?? "",
            label: observation.label,
            answer: observation.answer,
            latency_ms: observation.latencyMs,
            ...(event.expected_label !== undefined
              ? { expected_label: event.expected_label }
              : {}),
            matched,
          };
          if (
            event.max_latency_s !== undefined &&
            observation.latencyMs > event.max_latency_s * 1000
          ) {
            const message = `classifier latency ${observation.latencyMs}ms exceeds max_latency_s ${event.max_latency_s}s`;
            events.push({
              at_s: event.at_s,
              kind: event.kind,
              detail: message,
              ok: false,
              vision,
            });
            failures.push(`${event.kind} at ${event.at_s}s failed: ${message}`);
            break;
          }
          if (!matched) {
            const message = `label '${observation.label}' did not match expected '${event.expected_label}'`;
            events.push({
              at_s: event.at_s,
              kind: event.kind,
              detail: message,
              ok: false,
              vision,
            });
            failures.push(`${event.kind} at ${event.at_s}s failed: ${message}`);
            break;
          }
          events.push({
            at_s: event.at_s,
            kind: event.kind,
            detail: observation.answer,
            ok: true,
            vision,
          });
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({ at_s: event.at_s, kind: event.kind, detail: message, ok: false });
      failures.push(`${event.kind} at ${event.at_s}s failed: ${message}`);
    }
  }

  await advanceTo(scenario.end_s);
  return {
    schema: DEVICE_RESULT_SCHEMA,
    scenario: scenario.name,
    events,
    observed_reply_speech: observedReplySpeech,
    observed_vision: observedVision,
    result: { success: failures.length === 0, failures },
  };
}

export type VoiceScenarioWindowApi = {
  run: (scenario: unknown) => Promise<VoiceScenarioDeviceResult>;
  lastResult: VoiceScenarioDeviceResult | null;
};

declare global {
  interface Window {
    __KNOSH_VOICE_SCENARIO__?: VoiceScenarioWindowApi;
  }
}

/** Installs the automation window API; returns a teardown function. */
export function installVoiceScenarioWindowApi(
  hooks: VoiceScenarioDeviceHooks,
): () => void {
  const api: VoiceScenarioWindowApi = {
    lastResult: null,
    run: async (scenario: unknown) => {
      const result = await runVoiceScenarioOnDevice(scenario, hooks);
      api.lastResult = result;
      return result;
    },
  };
  window.__KNOSH_VOICE_SCENARIO__ = api;
  return () => {
    if (window.__KNOSH_VOICE_SCENARIO__ === api) {
      delete window.__KNOSH_VOICE_SCENARIO__;
    }
  };
}
