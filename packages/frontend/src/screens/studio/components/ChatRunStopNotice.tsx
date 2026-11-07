import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import type { ChatMessage } from "../types";
import { readChatRunStopNotice } from "./controllerConversationNotice";

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

/**
 * Who stopped the turn, when it was not the person reading: "Sam stopped
 * this". Null for their own Stop, and for a notice that names nobody (an older
 * one, or the Stop of a whole plan).
 */
export function stoppedByWords(message: ChatMessage, viewerUserId: string | null,
  humanLabelByUserId: ReadonlyMap<string, string> = new Map()): string | null {
  const notice = readChatRunStopNotice(message);
  if (!notice.requested || !notice.actorUserId || notice.actorUserId === viewerUserId) return null;
  return `${humanLabelByUserId.get(notice.actorUserId) ?? "A teammate"} stopped this`;
}

/**
 * What a stopped turn's row shows after its line ("Stopped · opened 5 pages on
 * frame.work ›"): who stopped it, when it was someone else, and Continue,
 * which carries the stopped request on (useChatRunStopContinuation) from the
 * chat's newest stopped turn only. Without the provider (thread previews,
 * tests) only the name shows. The words are a status, so a screen reader hears
 * the Stop as it lands; in a turn's row (`announce`), whose line is no live
 * region, an own Stop is heard as "Stopped".
 */
export function ChatRunStopActions({ notice, announce = false }: { notice: ChatMessage; announce?: boolean }) {
  const context = useContext(Context);
  const [pending, setPending] = useState(false);
  const [continued, setContinued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stoppedBy = stoppedByWords(notice, context?.viewerUserId ?? null, context?.humanLabelByUserId);
  const canContinue = !continued && context?.canContinue(notice);
  return (
    <>
      {stoppedBy ? (
        <Text as="span" variant="caption" tone="muted" role="status" data-testid="chat-run-stopped-by">{stoppedBy}</Text>
      ) : announce ? <span className="sr-only" role="status">Stopped</span> : null}
      {canContinue ? <Button variant="text" tone="muted" size="xs" isPending={pending}
        data-testid="chat-run-stop-continue" onPress={() => {
          if (pending || !context?.canContinue(notice)) return;
          setPending(true);
          setError(null);
          void context.onContinue(notice).then((sent) => {
            if (sent) setContinued(true);
            else setError("Could not continue this turn. Try again.");
          }).catch(() => setError("Could not continue this turn. Try again.")).finally(() => setPending(false));
        }}>Continue</Button> : null}
      {error ? <Text as="span" variant="caption" tone="muted" role="alert">{error}</Text> : null}
    </>
  );
}

/**
 * A Stop of a turn that has no row (it was stopped before it showed
 * anything): the one row that says so, as a stopped turn's own row does. A
 * turn with a row says it there (synthesizeAgentJobThreadMessages).
 */
export function ChatRunStopNotice({ message }: { message: ChatMessage }) {
  return (
    <div className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1" data-testid="chat-run-stop-notice">
      <Text as="span" variant="caption" tone="muted" role="status">Stopped</Text>
      <ChatRunStopActions notice={message} />
    </div>
  );
}
