/** Each speaker row's marker: who the row's speaker is, or a boundary where no one is named. */
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
