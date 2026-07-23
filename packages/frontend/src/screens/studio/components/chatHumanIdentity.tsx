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
    avatarSeed: humanAuthorId || clientSessionId || null,
    groupIdentity: `user:${speakerKey}`,
    label: humanAuthorId ? humanLabelByUserId.get(humanAuthorId) ?? "Teammate" : "Teammate",
  };
}

export function HumanSpeakerIdentityLabel({
  avatarSeed,
  label,
  timestamp,
}: {
  avatarSeed: string | null;
  label: string;
  timestamp?: number | null;
}) {
  const timestampInfo = formatSpeakerTimestamp(timestamp);
  return (
    <div
      className="inline-flex max-w-full items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
      data-testid="chat-human-speaker-label"
    >
      <ChatMessageAvatar
        kind="human"
        seed={avatarSeed}
        label={label}
        size="xs"
      />
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
