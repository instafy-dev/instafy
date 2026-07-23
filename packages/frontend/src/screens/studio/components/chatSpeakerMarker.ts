import { normalizeAssistantHandleLabel } from "./assistantSpeakerIdentity";

export const CHAT_SPEAKER_MARKER_SELECTOR = '[data-chat-speaker-marker="true"]';

export type ChatSpeakerMarker =
  | {
      kind: "assistant";
      handle: string;
      avatarSeed: string;
    }
  | {
      kind: "boundary";
    };

export type StickyAssistantSpeaker = {
  handle: string;
  avatarSeed: string;
};

export function isAssistantSpeakerMarker(marker: Element | null): marker is HTMLElement {
  return marker instanceof HTMLElement && marker.dataset.chatSpeakerKind === "assistant";
}

export function readStickyAssistantSpeakerMarker(
  marker: Element | null,
): StickyAssistantSpeaker | null {
  if (!isAssistantSpeakerMarker(marker)) {
    return null;
  }

  const handle = normalizeAssistantHandleLabel(marker.dataset.agentHandle);
  const avatarSeedValue = marker.dataset.agentAvatarSeed?.trim() ?? "";
  return { handle, avatarSeed: avatarSeedValue || handle };
}
