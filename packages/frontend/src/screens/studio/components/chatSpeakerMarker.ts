/** Each speaker row's marker: who the row's speaker is, or a boundary where no one is named. */
export const CHAT_SPEAKER_MARKER_SELECTOR = '[data-chat-speaker-marker="true"]';

export type ChatSpeakerMarker =
  | {
      kind: "assistant";
      handle: string;
      avatarSeed: string;
      /** The row's agent id, so the marker names the exact agent, not only its handle. */
      agentId?: string;
    }
  | {
      kind: "human";
      label: string;
      avatarSeed: string | null;
    }
  | {
      kind: "boundary";
    };
