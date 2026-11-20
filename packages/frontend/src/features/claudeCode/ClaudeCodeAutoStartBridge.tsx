import { useEffect, useMemo, useRef } from "react";
import { useActiveProjectId } from "../../feature-api/runtimeBridge";
import { useAuth } from "../../providers/AuthProvider";
import {
  canStartSpaceOnThisComputer,
  describeDesktopSpaceStartOutcome,
  startSpaceOnThisComputer,
} from "../../runtime/desktopSpaceStart";
import { useOptionalRuntimeState } from "../../runtime/RuntimeStateProvider";
import { controllerClient } from "../../sdk/instafy";
import { useStatus } from "../../status/useStatus";
import type { RunRecord } from "../../types";
import { claudeCodeDesktopHostAvailable, readClaudeCodeDesktopStatus } from "./claudeCodeDesktop";
import { isClaudeCodeControllerStamped } from "./claudeCodeTurnPresentation";

/**
 * Whether a run is a Claude Code turn of this person's that waits in this
 * space: queued, stamped by the controller, and theirs by the controller's
 * own `initiatingUserId` (the turn's job's person).
 */
export function isWaitingClaudeCodeTurnOf(run: RunRecord, projectId: string, userId: string): boolean {
  if (run.status !== "queued" || (run.projectId !== null && run.projectId !== projectId)) {
    return false;
  }
  const metadata = run.metadata;
  if (!metadata || !isClaudeCodeControllerStamped(metadata)) {
    return false;
  }
  const initiator = metadata["initiatingUserId"];
  return typeof initiator === "string" && initiator.trim() === userId;
}

async function resolveControllerUrl(): Promise<string | null> {
  const requestContext = await controllerClient.core.resolveRequestContext(null);
  return requestContext.baseUrl.trim() || null;
}

/**
 * Studio's own start of a space where a Claude Code turn of the person's
 * waits (docs/Local-Engine-Turns.md 11.14, D44). In Instafy Desktop, on a
 * computer where Claude Code is set up, it starts the open space on this
 * computer, as its Start action would, once per visit to the space, and only
 * while Desktop runs no runtime: it never replaces one by itself. The waiting
 * row's Start does that, and Desktop asks first while work runs there.
 */
export function ClaudeCodeAutoStartBridge() {
  const projectId = useActiveProjectId();
  const userId = useAuth().user?.id ?? null;
  const runs = useOptionalRuntimeState()?.runs ?? null;
  const { showStatus } = useStatus();
  const showStatusRef = useRef(showStatus);
  showStatusRef.current = showStatus;

  const turnWaits = useMemo(
    () =>
      Boolean(projectId && userId && runs) &&
      Object.values(runs ?? {}).some((run) => isWaitingClaudeCodeTurnOf(run, projectId!, userId!)),
    [projectId, runs, userId],
  );

  // The space this visit decided for: Studio decides once per visit, whatever
  // it found, so a runtime the person stops later is never started again. A
  // check cut short before it decided (the turn stopped waiting, or the
  // person left the space) decides nothing.
  const decidedRef = useRef<string | null>(null);
  useEffect(() => {
    if (decidedRef.current !== null && decidedRef.current !== projectId) {
      decidedRef.current = null;
    }
    if (
      !projectId ||
      !turnWaits ||
      decidedRef.current === projectId ||
      !canStartSpaceOnThisComputer() ||
      !claudeCodeDesktopHostAvailable()
    ) {
      return undefined;
    }
    let cancelled = false;
    const decide = () => {
      decidedRef.current = projectId;
    };
    void (async () => {
      const desktop = await readClaudeCodeDesktopStatus(await resolveControllerUrl().catch(() => null));
      if (cancelled) {
        return;
      }
      if (!desktop?.supported || !desktop.consented) {
        decide();
        return;
      }
      const running = await window.instafyDesktop?.desktopRuntimeStatus?.().catch(() => null);
      if (cancelled) {
        return;
      }
      decide();
      // Only when Desktop says it runs nothing: a runtime of another space,
      // or an answer it could not give, is left as it is.
      if (!running || running.running) {
        return;
      }
      const outcome = await startSpaceOnThisComputer(projectId);
      const status = describeDesktopSpaceStartOutcome(outcome);
      showStatusRef.current(status.message, status.intent, status.durationMs);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, turnWaits]);

  return null;
}

export default ClaudeCodeAutoStartBridge;
