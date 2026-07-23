import {
  createProviderArtifactReference,
  createProviderEventEnvelope,
  type ProviderEventEnvelope,
} from "@instafy/provider-contract";
export { PROVIDER_EVENT_DEBUG_INJECT_EVENT } from "./providerEventChannel";

export type ProviderEventSyntheticScenario =
  | "camera_capture"
  | "audio_wake_word"
  | "telemetry_burst";

type SyntheticEventRecord = ProviderEventEnvelope<Record<string, unknown>>;

function createTimestampNs(nowMs: number, offsetMs = 0) {
  return Math.max(0, nowMs + offsetMs) * 1_000_000;
}

export function createSyntheticProviderEvents(
  scenario: ProviderEventSyntheticScenario,
  options?: { nowMs?: number },
): SyntheticEventRecord[] {
  const nowMs = Math.floor(options?.nowMs ?? Date.now());

  switch (scenario) {
    case "camera_capture":
      return [
        createProviderEventEnvelope({
          kind: "camera.photo_captured",
          providerId: "camera",
          providerType: "phone_camera",
          timestampNs: createTimestampNs(nowMs),
          executionContext: {
            providerId: "camera",
            providerType: "phone_camera",
            runtime: {
              backendId: "phone_camera",
              transportKind: "native_mobile",
              executionSurface: "developer_details",
            },
          },
          artifactRefs: [
            createProviderArtifactReference({
              kind: "image_capture",
              role: "observation",
              uri: `/tmp/synthetic-camera-capture-${nowMs}.jpg`,
              title: "Synthetic capture",
              metadata: {
                captureId: `synthetic-capture-${nowMs}`,
                lens: "rear",
                capturedAt: new Date(nowMs).toISOString(),
              },
            }),
          ],
          payload: {
            mode: "single",
            lens: "rear",
            completedCount: 1,
            captureId: `synthetic-capture-${nowMs}`,
          },
        }),
      ];
    case "audio_wake_word":
      return [
        createProviderEventEnvelope({
          kind: "audio.wake_word_detected",
          providerId: "microphone",
          providerType: "phone_microphone",
          timestampNs: createTimestampNs(nowMs),
          executionContext: {
            providerId: "microphone",
            providerType: "phone_microphone",
            runtime: {
              backendId: "phone_microphone",
              transportKind: "native_mobile",
              executionSurface: "developer_details",
            },
          },
          payload: {
            label: "hey device",
            confidence: 0.98,
            durationMs: 640,
          },
        }),
      ];
    case "telemetry_burst":
    default:
      return Array.from({ length: 8 }, (_value, index) =>
        createProviderEventEnvelope({
          kind: "robot.telemetry_sampled",
          providerId: "robot-simulator",
          providerType: "robot_embodiment",
          timestampNs: createTimestampNs(nowMs, index * 150),
          executionContext: {
            providerId: "robot-simulator",
            providerType: "robot_embodiment",
            runtime: {
              backendId: "virtual_tcp",
              transportKind: "virtual_provider",
              transportTarget: "127.0.0.1:7777",
              executionSurface: "developer_details",
            },
          },
          payload: {
            category: "telemetry",
            sampleIndex: index,
            batteryPct: 82,
            headYawDeg: 4 + index,
          },
        }),
      );
  }
}
