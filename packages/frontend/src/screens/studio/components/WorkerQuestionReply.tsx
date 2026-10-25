import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { answerUserInputRequest, getUserInputRequest, type UserInputRequest } from "../../../services/runtimeController/userInputRequests";

const REQUEST_TIMEOUT_MS = 15_000;
type Selection = { scope: string; request: UserInputRequest; label: string; index: number; answers: Map<string, string> };
type ReplyHost = {
  select: (request: UserInputRequest, label: string) => void;
  observe: (request: UserInputRequest) => void;
  revision: number;
};
export const WorkerQuestionReplyContext = createContext<ReplyHost | null>(null);

/** A selection is scoped to this chat and to the controller-bound message, never an agent handle. */
export function useWorkerQuestionReply(options: {
  scope: string;
  readDraft: () => string;
  writeDraft: (text: string) => void;
  focusComposer: () => void;
  hasAttachments: boolean;
  canSelect?: () => boolean;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const savedSelections = useRef(new Map<string, Selection>());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const submission = useRef<AbortController | null>(null);
  const active = selection?.scope === options.scope ? selection : null;
  // A render for another chat immediately invalidates the old async callbacks.
  if (selectionRef.current?.scope !== options.scope) selectionRef.current = null;
  useEffect(() => {
    const saved = savedSelections.current.get(options.scope) ?? null;
    selectionRef.current = saved; setSelection(saved); setError(null); setBusy(false);
    return () => { submission.current?.abort(); submission.current = null; selectionRef.current = null; };
  }, [options.scope]);
  const replace = useCallback((next: Selection | null) => {
    if (next) savedSelections.current.set(next.scope, next);
    else savedSelections.current.delete(optionsRef.current.scope);
    selectionRef.current = next; setSelection(next);
  }, []);
  const select = useCallback((request: UserInputRequest, label: string) => {
    if (request.status !== "pending" || !request.canAnswer || submission.current) return;
    if (optionsRef.current.canSelect?.() === false) return;
    const current = selectionRef.current;
    if (current && (current.request.requestId !== request.requestId || current.request.messageId !== request.messageId)) {
      setError("Finish or cancel your current reply before answering another question.");
      optionsRef.current.focusComposer(); return;
    }
    replace(current ? { ...current, request } : { scope: optionsRef.current.scope, request, label, index: 0, answers: new Map() });
    setError(null); optionsRef.current.focusComposer();
  }, [replace]);
  const observe = useCallback((request: UserInputRequest) => {
    const current = selectionRef.current;
    if (!current || submission.current || current.request.requestId !== request.requestId || current.request.messageId !== request.messageId) return;
    replace({ ...current, request });
  }, [replace]);
  const cancel = useCallback(() => {
    if (submission.current) return;
    const current = selectionRef.current;
    if (current?.answers.size) {
      const answers = new Map(current.answers).set(current.request.questions[current.index].id, optionsRef.current.readDraft());
      optionsRef.current.writeDraft(current.request.questions.filter(question => answers.get(question.id)?.trim())
        .map(question => `${question.header}: ${answers.get(question.id)}`).join("\n\n"));
    }
    replace(null); setError(null); optionsRef.current.focusComposer();
  }, [replace]);
  const submit = useCallback(async (text: string, intent = "send"): Promise<boolean> => {
    const current = selectionRef.current;
    if (!current || submission.current) return false;
    if (intent === "queue" || intent === "stash") {
      setError("Send this reply now, or cancel the reply to queue or save an ordinary message."); return false;
    }
    if (optionsRef.current.hasAttachments) {
      setError("Worker replies accept text. Remove the attached images, or cancel this reply to send them to the chat."); return false;
    }
    const answer = text.trim();
    if (!answer || [...answer].length > 4000) {
      setError("Answer this question with at most 4,000 characters."); return false;
    }
    if (current.request.status === "expired" || (current.request.status === "pending" && !current.request.canAnswer)) {
      setError("This question is no longer available to answer. Your draft is kept below."); return false;
    }
    const nextAnswers = new Map(current.answers).set(current.request.questions[current.index].id, answer);
    if (current.index < current.request.questions.length - 1) {
      replace({ ...current, index: current.index + 1, answers: nextAnswers });
      setError(null);
      if (optionsRef.current.readDraft() === text) optionsRef.current.writeDraft(nextAnswers.get(current.request.questions[current.index + 1].id) ?? "");
      optionsRef.current.focusComposer(); return true;
    }
    const abort = new AbortController(); submission.current = abort; setBusy(true); setError(null);
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    const stillHere = () => !abort.signal.aborted && optionsRef.current.scope === current.scope && selectionRef.current?.request.requestId === current.request.requestId && selectionRef.current?.request.messageId === current.request.messageId;
    try {
      // Recheck authority and expiry even if this message's last poll was pending.
      const latest = await getUserInputRequest(current.request.requestId, current.request.messageId, abort.signal);
      if (!stillHere()) return false;
      if ((latest.status === "answered" || latest.status === "resumed") &&
        latest.answers && Array.from(nextAnswers).every(([id, answer]) => latest.answers?.[id]?.[0] === answer)) {
        if (optionsRef.current.readDraft() === text) optionsRef.current.writeDraft("");
        replace(null); setRevision(value => value + 1); return true;
      }
      if (latest.status !== "pending" || !latest.canAnswer) {
        replace({ ...current, request: latest });
        setError("This question is no longer available to answer. Your draft is kept below."); return false;
      }
      const response = await answerUserInputRequest(current.request.requestId, current.request.messageId,
        Object.fromEntries(Array.from(nextAnswers, ([id, value]) => [id, [value]])), abort.signal);
      if (!stillHere()) return false;
      if (response.status !== "answered" && response.status !== "resumed") {
        replace({ ...current, request: response });
        setError("Your answer has not been confirmed. Your draft is kept below."); return false;
      }
      if (optionsRef.current.readDraft() === text) optionsRef.current.writeDraft("");
      replace(null); setRevision(value => value + 1); return true;
    } catch {
      if (optionsRef.current.scope === current.scope && selectionRef.current?.request.requestId === current.request.requestId) {
        setError("Could not confirm your answer. Your draft is kept below; try again to check its status.");
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (submission.current === abort) { submission.current = null; setBusy(false); }
    }
  }, [replace]);
  const fillOption = useCallback((text: string) => {
    if (submission.current) return;
    optionsRef.current.writeDraft(text); optionsRef.current.focusComposer();
  }, []);
  const back = useCallback(() => {
    const current = selectionRef.current;
    if (!current || current.index === 0 || submission.current) return;
    const answers = new Map(current.answers).set(current.request.questions[current.index].id, optionsRef.current.readDraft());
    replace({ ...current, answers, index: current.index - 1 });
    optionsRef.current.writeDraft(answers.get(current.request.questions[current.index - 1].id) ?? "");
    setError(null); optionsRef.current.focusComposer();
  }, [replace]);
  const host = useMemo(() => ({ select, observe, revision }), [select, observe, revision]);
  return { active, busy, error, host, submit, cancel, fillOption, back };
}

export function WorkerQuestionReplyStrip({ reply }: { reply: ReturnType<typeof useWorkerQuestionReply> }) {
  const selected = reply.active;
  if (!selected) return null;
  const question = selected.request.questions[selected.index];
  const available = selected.request.status === "pending" && selected.request.canAnswer;
  return <div className="min-w-0 px-2 pt-1 text-xs text-slate-500 dark:text-slate-400" data-testid="worker-question-reply">
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate">Replying to <span className="font-medium text-slate-700 dark:text-slate-200">{selected.label}</span>
        {selected.request.questions.length > 1 ? ` · ${selected.index + 1} of ${selected.request.questions.length}` : null}</span>
      {selected.index > 0 ? <Button variant="ghost" size="sm" isDisabled={reply.busy} onPress={reply.back}>Back</Button> : null}
      <IconButton aria-label="Cancel worker reply" size="sm" variant="ghost" isDisabled={reply.busy} onPress={reply.cancel}><Xmark className="h-3.5 w-3.5" /></IconButton>
    </div>
    <p className="line-clamp-2" title={question.question}>{question.question}</p>
    {available && question.options?.length ? <div className="mt-1 flex flex-wrap gap-1">
      {question.options.map(option => <Button key={option.label} size="sm" variant="ghost" radius="full" title={option.description || undefined} isDisabled={reply.busy} onPress={() => reply.fillOption(option.label)}>{option.label}</Button>)}
    </div> : null}
    {!available ? <p role="status">{selected.request.expiredReason || "This question is no longer available to answer."}</p> : null}
    {reply.error ? <p role="alert" className="mt-1 text-amber-700 dark:text-amber-300">{reply.error}</p> : null}
    {reply.busy ? <span role="status">Sending answer…</span> : null}
  </div>;
}
