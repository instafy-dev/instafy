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

type RectLike = { top: number; height: number };

/**
 * The line the inline identity is handed off on: the centre of the sticky
 * pill's own box. The overlay holds that line whether or not a pill is
 * showing (an empty overlay sits on the roster row's centre, a filled one is
 * centred on it), so the pill appears exactly where the identity was, not
 * higher. Without an overlay to measure, fall back to the header inset.
 */
export function resolveSpeakerHandoffLine(
  containerTop: number,
  overlayRect: RectLike | null,
  fallbackInsetPx: number,
): number {
  if (overlayRect && Number.isFinite(overlayRect.top) && Number.isFinite(overlayRect.height)) {
    return overlayRect.top + overlayRect.height / 2;
  }
  return containerTop + fallbackInsetPx;
}

/**
 * Whether a message has scrolled up to the handoff line. With a visible
 * inline identity the test is its centre against the line, so the swap lands
 * on the same pixel row; the first version compared the identity's top edge
 * to the bottom of the fade, which swapped forty pixels early while the
 * identity was still fully readable. A marker with no visible identity (a
 * boundary, or a label the layout hides) uses its own top edge.
 */
export function hasReachedSpeakerHandoffLine(
  markerTop: number,
  inlineRect: RectLike | null,
  handoffLine: number,
): boolean {
  if (inlineRect && inlineRect.height > 0) {
    return inlineRect.top + inlineRect.height / 2 <= handoffLine;
  }
  return markerTop <= handoffLine;
}
