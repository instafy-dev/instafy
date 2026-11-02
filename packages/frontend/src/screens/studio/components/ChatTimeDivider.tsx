import { memo } from "react";
import { Text } from "../../../components/Text";
import { formatChatTimeDivider } from "./chatTimeDividers";

/** A chronological landmark, outside the message's selectable/cached content. */
export const ChatTimeDivider = memo(function ChatTimeDivider({ timestamp, now, messageId }: {
  timestamp: number;
  now: number;
  messageId: string;
}) {
  const time = formatChatTimeDivider(timestamp, now);
  if (!time) return null;
  return (
    <div className="flex justify-center py-2 text-center" data-testid="chat-time-divider" data-before-message-id={messageId}>
      <Text as="time" variant="caption" tone="muted" dateTime={time.dateTime} title={time.title}>
        {time.label}
      </Text>
    </div>
  );
});
