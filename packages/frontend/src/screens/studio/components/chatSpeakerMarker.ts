import { normalizeAssistantHandleLabel } from "./assistantSpeakerIdentity";

export const CHAT_SPEAKER_MARKER_SELECTOR = '[data-chat-speaker-marker="true"]';

export type ChatSpeakerMarker =
  | {
      kind: "assistant";
      handle: string;
      avatarSeed: string;
    }
  | {
      kind: "human";
      label: string;
      avatarSeed: string | null;
    }
  | {
      kind: "boundary";
    };

export type StickyChatSpeaker =
  | {
      kind: "assistant";
      handle: string;
      avatarSeed: string;
    }
  | {
      kind: "human";
      label: string;
      avatarSeed: string | null;
    };

export function isAssistantSpeakerMarker(marker: Element | null): marker is HTMLElement {
  return marker instanceof HTMLElement && marker.dataset.chatSpeakerKind === "assistant";
}

export function isHumanSpeakerMarker(marker: Element | null): marker is HTMLElement {
  return marker instanceof HTMLElement && marker.dataset.chatSpeakerKind === "human";
}

export function readStickyChatSpeakerMarker(
  marker: Element | null,
): StickyChatSpeaker | null {
  if (isAssistantSpeakerMarker(marker)) {
    const handle = normalizeAssistantHandleLabel(marker.dataset.agentHandle);
    const avatarSeedValue = marker.dataset.agentAvatarSeed?.trim() ?? "";
    return { kind: "assistant", handle, avatarSeed: avatarSeedValue || handle };
  }
  if (isHumanSpeakerMarker(marker)) {
    const label = marker.dataset.humanLabel?.trim() || "Teammate";
    const avatarSeedValue = marker.dataset.humanAvatarSeed?.trim() ?? "";
    return { kind: "human", label, avatarSeed: avatarSeedValue || null };
  }
  return null;
}
