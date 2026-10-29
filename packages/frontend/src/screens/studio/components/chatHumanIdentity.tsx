import type { ChatMessage } from "../types";
import { extractChatClientIdentity } from "./chatMessageDetailHelpers";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { formatSpeakerTimestamp } from "./chatSpeakerTimestamp";
import { HumanProfilePopover } from "../../../profile/HumanProfilePopover";

export type HumanChatIdentity = {
  avatarSeed: string | null;
  groupIdentity: string;
  label: string;
};

export function resolveHumanChatIdentity(
  message: ChatMessage,
  humanLabelByUserId: ReadonlyMap<string, string>,
): HumanChatIdentity {
  const authorId = typeof message.authorId === "string" ? message.authorId.trim() : "";
  const clientIdentity = extractChatClientIdentity(message.metadata);
  const clientUserId = clientIdentity?.userId ?? "";
  const clientSessionId = clientIdentity?.sessionId ?? "";
  const humanAuthorId = authorId || clientUserId;
  const speakerKey = (humanAuthorId || clientSessionId || "teammate").trim() || "teammate";
  return {
    avatarSeed: humanAuthorId || null,
    groupIdentity: `user:${speakerKey}`,
    label: humanAuthorId ? humanLabelByUserId.get(humanAuthorId) ?? "Teammate" : "Teammate",
  };
}

export function HumanSpeakerIdentityLabel({
  avatarSeed,
  label,
  timestamp,
  avatarVisibility = "always",
  projectId,
}: {
  avatarSeed: string | null;
  label: string;
  timestamp?: number | null;
  projectId?: string | null;
  /**
   * "narrow" hides the label's own avatar at sm+ where the message row's
   * avatar gutter shows the face instead, so name and body share one left
   * alignment line (#177).
   */
  avatarVisibility?: "always" | "narrow";
}) {
  const timestampInfo = formatSpeakerTimestamp(timestamp);
  return (
    <div
      className="inline-flex max-w-full items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
      data-testid="chat-human-speaker-label"
    >
      <HumanProfilePopover projectId={projectId} userId={avatarSeed} displayName={label} className="inline-flex min-w-0 items-center gap-2 rounded-lg text-left">
        <span className={`flex-none ${avatarVisibility === "narrow" ? "sm:hidden" : ""}`.trim()}>
          <ChatMessageAvatar
            kind="human"
            seed={avatarSeed}
            label={label}
            size="xs"
          />
        </span>
        <span className="min-w-0 truncate font-semibold text-slate-600 dark:text-slate-300">
          {label}
        </span>
      </HumanProfilePopover>
      {timestampInfo ? (
        <time
          className="flex-none text-xxs font-medium text-slate-400 dark:text-slate-500"
          dateTime={timestampInfo.dateTime}
          title={timestampInfo.title}
        >
          {timestampInfo.label}
        </time>
      ) : null}
    </div>
  );
}
