import { startTransition, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { endReplyDraftRun } from "../../../conversations/replyDrafts";
import { useOptionalRuntimeState } from "../../../runtime/RuntimeStateProvider";
import { stopConversationJobs, type ControllerConversationStopResult } from "../../../services/runtimeController/conversationStop";
import { chatRunStopEscapeBlocked } from "./chatRunStopEscape";
import { chatRunStopNeedsConfirmation, groupChatRunStopTargets, runsCanceledByStop, type ChatRunStopTarget } from "./chatRunStopTargets";

export type { ChatRunStopTarget } from "./chatRunStopTargets";
export const CHAT_RUN_STOP_TIMEOUT_MS = 20_000;
/**
 * How long Stop keeps its place after the turns it would stop end by
 * themselves. The record that ends one part of a message and the one that
 * starts the next (a browser card's continuation, a hand-back to the building
 * turn) can come a moment apart: Stop stays put across that moment.
 */
export const CHAT_RUN_STOP_HANDOVER_MS = 600;
export type ChatRunStopPhase = "idle" | "stopping" | "requested" | "error";

export type ChatRunStopOptions = {
  conversationId: string | null;
  targets: readonly ChatRunStopTarget[];
  canStop: boolean;
  viewerUserId: string | null;
  active?: boolean;
  escapeBlocked?: boolean;
  cancelJobs?: (conversationId: string, jobIds: readonly string[]) => Promise<ControllerConversationStopResult>;
  onStopped?: (result: ControllerConversationStopResult, targets: readonly ChatRunStopTarget[]) => void;
  /**
   * The chat's message is between two of its parts: one has ended, and the
   * next, which goes on by itself (a browser card's continuation, a hand-back
   * to the building turn, Instafy's own retry of a failed turn), has not
   * started yet. Stop stays meanwhile, and a press stops that part as it starts.
   */
  between?: boolean;
  /**
   * Of `targets`, those that carry a message on by themselves
   * (chatRunStopFollowOnTargets): the only turns a press between two parts
   * stops once they start, never a message someone sends.
   */
  followOnTargets?: readonly ChatRunStopTarget[];
};

type StopState = {
  conversationId: string | null;
  phase: ChatRunStopPhase;
  attemptedTargets: ChatRunStopTarget[];
  confirmationTargets: ChatRunStopTarget[] | null;
  acceptedJobIds: string[];
  error: string | null;
  /** Pressed between two parts: the next part is stopped as it starts. */
  awaitingNext: boolean;
};

function emptyState(conversationId: string | null): StopState {
  return {
    conversationId, phase: "idle", attemptedTargets: [], confirmationTargets: null, acceptedJobIds: [], error: null,
    awaitingNext: false,
  };
}

function effectivePhase(state: StopState, targets: readonly ChatRunStopTarget[]): ChatRunStopPhase {
  if (state.awaitingNext) return "stopping";
  if (state.phase !== "requested") return state.phase;
  const hasUnrequestedTarget = targets.some((target) => !state.acceptedJobIds.includes(target.jobId));
  const requestedStillActive = state.attemptedTargets.some((target) => targets.some((candidate) => candidate.jobId === target.jobId));
  return hasUnrequestedTarget || !requestedStillActive ? "idle" : "requested";
}

export function useChatRunStop(options: ChatRunStopOptions) {
  const feedbackId = useId();
  const { conversationId, targets, canStop, active = true } = options;
  const [storedState, setState] = useState(() => emptyState(conversationId));
  const state = storedState.conversationId === conversationId ? storedState : emptyState(conversationId);
  // The chat's run records, where the Stop's answer is written.
  const runRecords = useOptionalRuntimeState();
  // The turns it would stop ended by themselves a moment ago: the next part
  // of the same message may be on its way (CHAT_RUN_STOP_HANDOVER_MS).
  const [handingOver, setHandingOver] = useState(false);
  const between = options.between === true || handingOver;
  const latest = useRef({ options, state, runRecords, between });
  latest.current = { options, state, runRecords, between };
  const operation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current += 1; };
  }, []);
  useEffect(() => {
    operation.current += 1;
    busy.current = false;
    setState(emptyState(conversationId));
    setHandingOver(false);
  }, [conversationId]);
  // Before the frame that would draw no Stop: the turns ended by themselves,
  // none of them by this Stop.
  const shownJobIds = targets.filter((target) => !state.acceptedJobIds.includes(target.jobId)).map((target) => target.jobId);
  const shownJobIdsKey = shownJobIds.join(",");
  const lastShown = useRef<{ conversationId: string | null; jobIds: string[] }>({ conversationId, jobIds: [] });
  useLayoutEffect(() => {
    const ended = lastShown.current.conversationId === conversationId ? lastShown.current.jobIds : [];
    lastShown.current = { conversationId, jobIds: shownJobIdsKey ? shownJobIdsKey.split(",") : [] };
    if (lastShown.current.jobIds.length > 0) {
      setHandingOver(false);
      return;
    }
    if (ended.length > 0 && !ended.some((jobId) => latest.current.state.acceptedJobIds.includes(jobId))) {
      setHandingOver(true);
    }
  }, [conversationId, shownJobIdsKey]);
  useEffect(() => {
    if (!handingOver) return undefined;
    const timer = setTimeout(() => setHandingOver(false), CHAT_RUN_STOP_HANDOVER_MS);
    return () => clearTimeout(timer);
  }, [handingOver]);
  useEffect(() => {
    if (state.phase !== "requested") return;
    if (effectivePhase(state, targets) === "idle") setState((previous) => ({ ...previous, phase: "idle", attemptedTargets: [] }));
  }, [state, targets]);

  const execute = useCallback(async (selection: readonly ChatRunStopTarget[]) => {
    const current = latest.current.options;
    if (!current.canStop || current.active === false || !current.conversationId || busy.current || selection.length === 0) return;
    const captured = [...new Map(selection.map((target) => [target.jobId, { ...target }])).values()];
    const capturedConversation = current.conversationId;
    const requestId = ++operation.current;
    busy.current = true;
    // The Stop's request goes out first. The chat draws "Stopping…" as a
    // transition, which yields while it draws, so the request's sign-in lookup
    // and its send run in between. Drawn first, a long chat held the request
    // back by the whole drawing: it reached the controller 37 to 93 ms after
    // the press in a local test (Nov 7), before the Stop could even begin.
    // `busy` already refuses a second press meanwhile.
    startTransition(() => {
      setState((previous) => ({
        ...(previous.conversationId === capturedConversation ? previous : emptyState(capturedConversation)),
        phase: "stopping", attemptedTargets: captured, confirmationTargets: null, error: null, awaitingNext: false,
      }));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => mounted.current && operation.current === requestId
      && latest.current.options.conversationId === capturedConversation;
    try {
      const result = await Promise.race([
        (current.cancelJobs ?? stopConversationJobs)(capturedConversation, captured.map((target) => target.jobId)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The stop has not been confirmed. It may still take effect. Retry to check the same turns.")), CHAT_RUN_STOP_TIMEOUT_MS);
        }),
      ]);
      if (!isCurrent()) return;
      if (!result.ok) throw new Error("The stop was not confirmed. Try again.");
      const accepted = new Set([...result.canceledJobIds, ...result.alreadyFinishedJobIds]);
      const unfinished = captured.filter((target) => !accepted.has(target.jobId));
      const acknowledged = captured.filter((target) => accepted.has(target.jobId));
      setState((previous) => ({
        ...previous,
        phase: unfinished.length ? "error" : "requested",
        attemptedTargets: unfinished.length ? unfinished : captured,
        acceptedJobIds: [...new Set([...previous.acceptedJobIds, ...acknowledged.map((target) => target.jobId)])],
        error: unfinished.length ? "Some turns did not confirm the stop. Retry those turns." : null,
      }));
      // The answer comes once the controller has committed the Stop, as the
      // run's own record on its stream does, which can take longer to arrive.
      // The runs it canceled read canceled now, as that record would make
      // them (their reply drafts end too), so the turn's row says "Stopped"
      // as the answer lands. A Stop that failed, timed out or found its turn
      // already finished writes nothing.
      const records = latest.current.runRecords;
      if (records) {
        for (const run of runsCanceledByStop(result, records.runs)) {
          endReplyDraftRun(run.id);
          records.upsertRun(run);
        }
      }
      if (acknowledged.length) current.onStopped?.(result, acknowledged);
    } catch (error) {
      if (isCurrent()) setState((previous) => ({
        ...previous,
        phase: "error",
        error: error instanceof Error ? error.message : "Could not confirm the stop. Try again.",
      }));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (isCurrent()) busy.current = false;
    }
  }, []);

  const requestStop = useCallback((selection?: readonly ChatRunStopTarget[]) => {
    const current = latest.current;
    if (!current.options.canStop || current.options.active === false || !current.options.conversationId || busy.current) return;
    const captured = (selection ?? current.options.targets.filter((target) => !current.state.acceptedJobIds.includes(target.jobId)))
      .map((target) => ({ ...target }));
    if (captured.length === 0) {
      // Between two parts of a message nothing runs yet: the press waits for
      // the part that goes on by itself, and stops it as it starts.
      if (!selection && current.between && !current.state.awaitingNext) {
        setState((previous) => ({
          ...(previous.conversationId === current.options.conversationId ? previous : emptyState(current.options.conversationId)),
          phase: "idle", attemptedTargets: [], confirmationTargets: null, error: null, awaitingNext: true,
        }));
      }
      return;
    }
    if (chatRunStopNeedsConfirmation(captured, current.options.viewerUserId)) {
      setState((previous) => ({
        ...(previous.conversationId === current.options.conversationId ? previous : emptyState(current.options.conversationId)),
        confirmationTargets: captured, awaitingNext: false,
      }));
      return;
    }
    void execute(captured);
  }, [execute]);
  // A press between two parts: the next one is stopped as it starts, as if
  // the press came then. Nothing more comes (the part never started, or
  // someone wrote meanwhile): nothing is left to stop.
  const followOnKey = (options.followOnTargets ?? [])
    .filter((target) => !state.acceptedJobIds.includes(target.jobId))
    .map((target) => target.jobId)
    .join(",");
  useEffect(() => {
    if (!state.awaitingNext) return;
    const current = latest.current;
    const next = (current.options.followOnTargets ?? []).filter((target) => !state.acceptedJobIds.includes(target.jobId));
    if (next.length > 0 && current.options.canStop && current.options.active !== false) {
      requestStop(next);
      return;
    }
    if (next.length > 0 || !between) {
      setState((previous) => ({ ...previous, awaitingNext: false }));
    }
  }, [between, followOnKey, requestStop, state.acceptedJobIds, state.awaitingNext]);
  const confirmStop = useCallback(() => {
    const captured = latest.current.state.confirmationTargets;
    if (captured) void execute(captured);
  }, [execute]);
  const dismissConfirmation = useCallback(() => setState((previous) => ({ ...previous, confirmationTargets: null })), []);
  const retry = useCallback(() => {
    // The previous attempt was already authorized. Its frozen IDs cannot pick
    // up a replacement job or another person's later request.
    void execute(latest.current.state.attemptedTargets);
  }, [execute]);

  useEffect(() => {
    const blockedEvents = new WeakSet<KeyboardEvent>();
    const snapshotEscapeOwner = (event: KeyboardEvent) => {
      const current = latest.current;
      if (chatRunStopEscapeBlocked(event, {
        active: current.options.active !== false && current.options.canStop,
        blocked: current.options.escapeBlocked || Boolean(current.state.confirmationTargets),
      })) blockedEvents.add(event);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || blockedEvents.has(event)) return;
      // Let existing document/window handlers consume the key first, including
      // handlers registered after this one. The capture listener only observes.
      queueMicrotask(() => {
        if (event.defaultPrevented || event.cancelBubble || blockedEvents.has(event)) return;
        const current = latest.current;
        if (chatRunStopEscapeBlocked(event, {
          active: current.options.active !== false && current.options.canStop,
          blocked: current.options.escapeBlocked || effectivePhase(current.state, current.options.targets) !== "idle" || Boolean(current.state.confirmationTargets),
        })) return;
        requestStop();
      });
    };
    window.addEventListener("keydown", snapshotEscapeOwner, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", snapshotEscapeOwner, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, [requestStop]);

  const availableTargets = targets.filter((target) => !state.acceptedJobIds.includes(target.jobId));
  const phase = effectivePhase(state, targets);
  const visible = active && canStop && Boolean(conversationId)
    && (availableTargets.length > 0 || phase === "stopping" || phase === "error" || phase === "requested" || between);
  return {
    visible, phase, feedbackId, targets: availableTargets, groups: groupChatRunStopTargets(availableTargets),
    error: state.error, confirmationTargets: state.confirmationTargets,
    requestStop, confirmStop, dismissConfirmation, retry,
  };
}

export type ChatRunStopController = ReturnType<typeof useChatRunStop>;
