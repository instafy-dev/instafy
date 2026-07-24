import { useCallback, useEffect, useRef, useState } from "react";
import { readGroupParticipationAgentDeclined } from "../../../conversations/groupParticipation";
import type { RunRecord, RunStatus } from "../../../types";

/** Per-browser one-shot flag: the silence hint is shown at most once, ever. */
export const OCTO_SILENCE_HINT_STORAGE_KEY = "gpSilenceHintShownV1";

export const OCTO_SILENCE_HINT_AUTO_DISMISS_MS = 12_000;

function hasShownSilenceHint(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(OCTO_SILENCE_HINT_STORAGE_KEY) === "1";
  } catch {
    // Storage unavailable — fail quiet and never show rather than repeating.
    return true;
  }
}

function markSilenceHintShown(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(OCTO_SILENCE_HINT_STORAGE_KEY, "1");
  } catch {
    // Ignore storage failures; the hint simply may reappear next session.
  }
}

/**
 * One-time discoverability hint for skill-mode group silence. The first time
 * this browser *witnesses* an ambient run complete as a swallowed agent
 * decline (`groupParticipation: { decision: "silent", reason: "agent_declined" }`)
 * in the eligible (multi-human, assistant-enabled) conversation, `visible`
 * flips true for ~12s so the caller can render an ephemeral, dismissible line
 * near the composer. The per-browser flag is set the moment the hint shows —
 * it never shows again.
 *
 * "Witnessed" means the run was previously observed in a non-terminal state in
 * this session; historical declines that arrive already completed never fire.
 */
export function useOctoSilenceHint({
  runs,
  conversationControllerId,
  eligible,
}: {
  runs: Record<string, RunRecord> | null | undefined;
  conversationControllerId: string | null;
  eligible: boolean;
}): { visible: boolean; dismiss: () => void } {
  const [visible, setVisible] = useState(false);
  const seenRunStatusesRef = useRef<Map<string, RunStatus>>(new Map());

  useEffect(() => {
    const seenRunStatuses = seenRunStatusesRef.current;
    let witnessedDecline = false;
    for (const run of Object.values(runs ?? {})) {
      const runId = typeof run.id === "string" ? run.id.trim() : "";
      if (!runId) {
        continue;
      }
      const previousStatus = seenRunStatuses.get(runId) ?? null;
      seenRunStatuses.set(runId, run.status);
      if (
        !eligible ||
        !conversationControllerId ||
        run.conversationId !== conversationControllerId
      ) {
        continue;
      }
      if (
        previousStatus !== null &&
        previousStatus !== "success" &&
        run.status === "success" &&
        readGroupParticipationAgentDeclined(run.metadata)
      ) {
        witnessedDecline = true;
      }
    }
    if (!witnessedDecline || hasShownSilenceHint()) {
      return;
    }
    markSilenceHintShown();
    setVisible(true);
  }, [conversationControllerId, eligible, runs]);

  useEffect(() => {
    if (!visible || typeof window === "undefined") {
      return;
    }
    const timer = window.setTimeout(() => {
      setVisible(false);
    }, OCTO_SILENCE_HINT_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const dismiss = useCallback(() => setVisible(false), []);

  return { visible, dismiss };
}
