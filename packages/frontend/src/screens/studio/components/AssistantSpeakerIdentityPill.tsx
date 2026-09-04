import { WarningTriangle } from "iconoir-react";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { requestAgentProfile } from "./agentProfileOpen";
import type {
  AssistantAgentIdentity,
  AssistantAvatarMotion,
} from "./chatAssistantIdentity";
import { normalizeAssistantHandleLabel } from "./assistantSpeakerIdentity";
import { formatSpeakerTimestamp } from "./chatSpeakerTimestamp";

function resolveAvatarSeed(
  normalizedHandle: string,
  agentIdentity: AssistantAgentIdentity | null | undefined,
): string {
  return agentIdentity?.avatarSeed ?? normalizedHandle;
}

export function AssistantSpeakerIdentityPill({
  handle,
  metadata = null,
  agentIdentity = null,
  motion = "idle",
}: {
  handle: string | null | undefined;
  metadata?: Record<string, unknown> | null;
  agentIdentity?: AssistantAgentIdentity | null;
  motion?: AssistantAvatarMotion;
}) {
  const normalizedHandle = normalizeAssistantHandleLabel(handle);
  const avatarSeed = resolveAvatarSeed(normalizedHandle, agentIdentity);

  return (
    <div
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200/70 bg-white/95 py-0 pl-0.5 pr-2 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200"
      data-agent-handle={normalizedHandle}
    >
      <ChatMessageAvatar
        kind="assistant"
        metadata={metadata ?? null}
        agent={{ handle: normalizedHandle, avatarSeed }}
        motion={motion}
        scrollReactive={motion === "thinking"}
        size="xs"
      />
      <span className="min-w-0 truncate">{normalizedHandle}</span>
    </div>
  );
}

export type SpeakerStatusMarker = {
  label: string;
  tone: "danger" | "warning";
};

// Status is header vocabulary, not chip vocabulary: a tinted text label beside
// the author and timestamp, never a filled pill (#145).
export function SpeakerStatusMarkerLabel({ marker }: { marker: SpeakerStatusMarker }) {
  return (
    <span
      data-testid="chat-speaker-run-status"
      className={`inline-flex min-w-0 flex-none items-center gap-1 text-xxs font-semibold ${
        marker.tone === "danger"
          ? "text-rose-600 dark:text-rose-300"
          : "text-secondary-700 dark:text-secondary-200"
      }`}
    >
      <WarningTriangle aria-hidden="true" className="h-3 w-3 flex-none" />
      <span className="min-w-0 truncate">{marker.label}</span>
    </span>
  );
}

export function AssistantSpeakerIdentityLabel({
  handle,
  timestamp,
  metadata = null,
  agentIdentity = null,
  motion = "idle",
  avatarVisibility = "always",
  statusMarker = null,
}: {
  handle: string | null | undefined;
  timestamp?: number | null;
  metadata?: Record<string, unknown> | null;
  agentIdentity?: AssistantAgentIdentity | null;
  motion?: AssistantAvatarMotion;
  /**
   * "narrow" hides the label's own avatar at sm+ where the avatar gutter of
   * the message row shows the face instead — name, timestamp, and body then
   * share one left alignment line (#177). Narrow layouts keep the inline
   * avatar because the gutter collapses there.
   */
  avatarVisibility?: "always" | "narrow";
  statusMarker?: SpeakerStatusMarker | null;
}) {
  const normalizedHandle = normalizeAssistantHandleLabel(handle);
  const avatarSeed = resolveAvatarSeed(normalizedHandle, agentIdentity);
  const timestampInfo = formatSpeakerTimestamp(timestamp);

  return (
    <div
      className="inline-flex max-w-full items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
      data-agent-handle={normalizedHandle}
    >
      {/* Where the gutter is collapsed this label is the transcript's profile
          door — ChatPanel hosts the card by handle. */}
      <button
        type="button"
        onClick={() => requestAgentProfile(normalizedHandle)}
        aria-label={`View profile for ${normalizedHandle}`}
        data-testid="chat-speaker-agent-profile"
        className={`flex-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${
          avatarVisibility === "narrow" ? "sm:hidden" : ""
        }`.trim()}
      >
        <ChatMessageAvatar
          kind="assistant"
          metadata={metadata ?? null}
          agent={{ handle: normalizedHandle, avatarSeed }}
          motion={motion}
          scrollReactive={motion === "thinking"}
          size="xs"
        />
      </button>
      <span className="min-w-0 truncate font-semibold text-slate-600 dark:text-slate-300">
        {normalizedHandle}
      </span>
      {timestampInfo ? (
        <time
          className="flex-none text-xxs font-medium text-slate-400 dark:text-slate-500"
          dateTime={timestampInfo.dateTime}
          title={timestampInfo.title}
        >
          {timestampInfo.label}
        </time>
      ) : null}
      {statusMarker ? <SpeakerStatusMarkerLabel marker={statusMarker} /> : null}
    </div>
  );
}
