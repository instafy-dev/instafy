import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
import type { ChatMessage } from "../types";

type StopNoticeContextValue = {
  viewerUserId: string | null;
  humanLabelByUserId: ReadonlyMap<string, string>;
  canContinue: (message: ChatMessage) => boolean;
  onContinue: (message: ChatMessage) => Promise<boolean>;
};

const Context = createContext<StopNoticeContextValue | null>(null);

export function ChatRunStopNoticeProvider({ value, children }: {
  value: StopNoticeContextValue;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function readChatRunStopNotice(message: ChatMessage) {
  const metadata = message.metadata;
  const details = metadata && typeof metadata === "object" && "details" in metadata
    && metadata.details && typeof metadata.details === "object" && !Array.isArray(metadata.details)
    ? metadata.details as Record<string, unknown> : {};
  const strings = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    : [];
  return {
    requested: details.stopRequested === true,
    actorUserId: typeof details.actorUserId === "string" ? details.actorUserId : null,
    handles: strings(details.agentHandles).filter((handle) => /^[a-z0-9][a-z0-9_-]*$/i.test(handle)),
    runIds: strings(details.runIds),
    jobIds: strings(details.jobIds),
  };
}

export function chatRunStopNoticeText(message: ChatMessage, viewerUserId: string | null,
  humanLabelByUserId: ReadonlyMap<string, string> = new Map()): string {
  const notice = readChatRunStopNotice(message);
  if (!notice.requested) return "Run stopped.";
  const names = notice.handles.map((handle) => getBuiltInAssistantDisplayName(handle) ?? `@${handle}`);
  const agents = names.length ? new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names) : "the agent";
  const actor = notice.actorUserId && notice.actorUserId === viewerUserId ? "You"
    : notice.actorUserId ? humanLabelByUserId.get(notice.actorUserId) ?? "A teammate" : "Someone";
  // The controller confirms the request, not that the remote process has
  // already exited. Preserve that distinction in persisted history too.
  return `${actor} asked ${agents} to stop.`;
}

/** Calm persisted cancellation history; separate from Machines > Stop. */
export function ChatRunStopNotice({ message }: { message: ChatMessage }) {
  const context = useContext(Context);
  const [pending, setPending] = useState(false);
  const [continued, setContinued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canContinue = !continued && context?.canContinue(message);
  return (
    <div className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1" data-testid="chat-run-stop-notice">
      <Text as="span" variant="caption" tone="muted" role="status">
        {chatRunStopNoticeText(message, context?.viewerUserId ?? null, context?.humanLabelByUserId)}
      </Text>
      {canContinue ? <Button variant="text" tone="muted" size="xs" isPending={pending}
        data-testid="chat-run-stop-continue" onPress={() => {
          if (pending || !context?.canContinue(message)) return;
          setPending(true);
          setError(null);
          void context.onContinue(message).then((sent) => {
            if (sent) setContinued(true);
            else setError("Could not continue this turn. Try again.");
          }).catch(() => setError("Could not continue this turn. Try again.")).finally(() => setPending(false));
        }}>Continue</Button> : null}
      {error ? <Text as="span" variant="caption" tone="muted" role="alert">{error}</Text> : null}
    </div>
  );
}
