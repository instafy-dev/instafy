import type { ChatMessage } from "../types";
import { extractChatClientIdentity } from "./chatMessageDetailHelpers";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { formatSpeakerTimestamp } from "./chatSpeakerTimestamp";

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

export function HumanSpeakerIdentityPill({
  avatarSeed,
  label,
}: {
  avatarSeed: string | null;
  label: string;
}) {
  return (
    <div
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200/70 bg-white/95 py-0 pl-0.5 pr-2 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200"
      data-testid="chat-human-speaker-pill"
    >
      <ChatMessageAvatar
        kind="human"
        seed={avatarSeed}
        label={label}
        size="xs"
      />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

export function HumanSpeakerIdentityLabel({
  avatarSeed,
  label,
  timestamp,
  avatarVisibility = "always",
}: {
  avatarSeed: string | null;
  label: string;
  timestamp?: number | null;
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
