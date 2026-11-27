import { isRecord } from "../utils/isRecord";

export type ProviderEventHostReaction =
  | "record_only"
  | "surface_in_conversation"
  | "candidate_agent_trigger";

export function resolveProviderEventHostReaction(value: unknown): ProviderEventHostReaction {
  if (!isRecord(value)) {
    return "record_only";
  }

  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  if (!kind) {
    return "record_only";
  }

  if (kind === "camera.photo_captured" || kind === "camera.photo_series_captured") {
    return "surface_in_conversation";
  }

  if (kind === "audio.wake_word_detected") {
    return "candidate_agent_trigger";
  }

  return "record_only";
}
