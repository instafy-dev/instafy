import { WarningTriangle } from "iconoir-react";
import { formatAiAccessibleName } from "../../../components/AiTag";
import { AI_TILE_SHAPE_CLASS } from "../../../components/OctoCoin";
import { Button } from "../../../components/Button";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { requestAgentProfile } from "./agentProfileOpen";
import type {
  AssistantAgentIdentity,
  AssistantAvatarMotion,
} from "./chatAssistantIdentity";
import { extractAgentIdentityFromMetadata, resolveObservedAgentIdentity } from "./chatAssistantIdentity";
import { normalizeAssistantHandleLabel } from "./assistantSpeakerIdentity";
import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
import { formatSpeakerTimestamp } from "./chatSpeakerTimestamp";
import "./ChatIdentityLayout.css";

function resolveAvatarSeed(
  normalizedHandle: string,
  agentIdentity: AssistantAgentIdentity | null | undefined,
): string {
  return agentIdentity?.avatarSeed ?? normalizedHandle;
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
   * "narrow" hides the label's own avatar in a wide transcript where the message
   * row's gutter shows the face instead — name, timestamp, and body then
   * share one left alignment line (#177). Narrow layouts keep the inline
   * avatar because the gutter collapses there.
   */
  avatarVisibility?: "always" | "narrow";
  statusMarker?: SpeakerStatusMarker | null;
}) {
  const normalizedHandle = normalizeAssistantHandleLabel(handle);
  // Named as the rest of Studio names it: Octo, not its handle "octo".
  const shownName = getBuiltInAssistantDisplayName(normalizedHandle) ?? normalizedHandle;
  const avatarSeed = resolveAvatarSeed(normalizedHandle, agentIdentity);
  const timestampInfo = formatSpeakerTimestamp(timestamp);

  return (
    <div
      className="inline-flex max-w-full items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
      data-agent-handle={normalizedHandle}
    >
      {/* Preserve the exact observed agent when the avatar gutter is collapsed. */}
      <Button
        type="button"
        variant="text"
        size="xs"
        radius="lg"
        onPress={() => requestAgentProfile(normalizedHandle,
          resolveObservedAgentIdentity(agentIdentity, extractAgentIdentityFromMetadata(metadata)))}
        aria-label={formatAiAccessibleName(`View profile for ${shownName}`)}
        data-testid="chat-speaker-agent-profile"
        className="min-w-0 max-w-full justify-start"
      >
        <span className={`chat-speaker-inline-avatar flex-none ${AI_TILE_SHAPE_CLASS} ${avatarVisibility === "narrow" ? "chat-speaker-inline-avatar--narrow" : ""}`}>
          <ChatMessageAvatar
            kind="assistant"
            metadata={metadata ?? null}
            agent={{ handle: normalizedHandle, avatarSeed, id: agentIdentity?.id }}
            motion={motion}
            scrollReactive={motion === "thinking"}
            size="xs"
          />
        </span>
        <span className="min-w-0 truncate font-semibold text-slate-600 dark:text-slate-300" data-testid="chat-speaker-name">
          {shownName}
        </span>
      </Button>
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
