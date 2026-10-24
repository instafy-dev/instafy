import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { getUserInputRequest, type UserInputRequest } from "../../../services/runtimeController/userInputRequests";
import { WorkerQuestionReplyContext } from "./WorkerQuestionReply";

const POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/** Ordinary message presentation with an explicit Reply option for a controller-bound answer target. */
export function UserInputRequestEntry({ requestId, messageId, taskLabel }: { requestId: string; messageId: string; taskLabel?: string }) {
  return <BoundUserInputRequest key={`${messageId}:${requestId}`} requestId={requestId} messageId={messageId} taskLabel={taskLabel} />;
}

function BoundUserInputRequest({ requestId, messageId, taskLabel }: { requestId: string; messageId: string; taskLabel?: string }) {
  const reply = useContext(WorkerQuestionReplyContext);
  const [request, setRequest] = useState<UserInputRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState(0);
  const failures = useRef(0);
  const status = request?.status;
  const settled = status === "resumed" || status === "expired";
  const observe = reply?.observe;
  const revision = reply?.revision;
  useEffect(() => {
    if (settled) return;
    const abort = new AbortController();
    let active = true;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    void getUserInputRequest(requestId, messageId, abort.signal).then(value => {
      if (!active) return;
      failures.current = 0; setRequest(value); setLoadError(null); observe?.(value);
      if (value.status === "pending" || value.status === "answered") poll = setTimeout(() => setCheck(current => current + 1), POLL_MS);
    }).catch(() => {
      if (!active) return;
      setLoadError("Could not check this question.");
      const delay = RETRY_DELAYS_MS[failures.current++];
      if (delay !== undefined) poll = setTimeout(() => setCheck(current => current + 1), delay);
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; abort.abort(); clearTimeout(timeout); clearTimeout(poll); };
  }, [check, requestId, messageId, settled, observe, revision]);

  const terminalText = status === "answered" ? "Answer saved. Waiting to continue."
    : status === "resumed" ? "Answered"
    : status === "expired" ? request?.expiredReason ?? "This question is no longer available."
    : status === "pending" && !request?.canAnswer ? "Waiting for the person who started this task to answer." : null;
  const canReply = reply && request?.status === "pending" && request.canAnswer;
  return <div data-testid="user-input-request-message" className="min-w-0 space-y-2 text-sm leading-relaxed text-slate-800 dark:text-slate-100">
    {request ? request.questions.map(question => <p key={question.id} className="whitespace-pre-wrap break-words">{question.question}</p>)
      : <p>{loadError ? "Question unavailable" : "Loading question…"}</p>}
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      {canReply ? <Button variant="ghost" size="sm" onPress={() => reply.select(request, taskLabel || request.agentHandle || "worker")} data-testid="user-input-request-reply">Reply</Button> : null}
      {terminalText ? <span role="status" data-testid="user-input-request-status">{terminalText}</span> : null}
      {loadError ? <Button variant="ghost" size="sm" onPress={() => { failures.current = 0; setCheck(current => current + 1); }} data-testid="user-input-request-check">Check status</Button> : null}
    </div>
    {loadError ? <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{loadError}</p> : null}
  </div>;
}
