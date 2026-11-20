import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Text } from "../../components/Text";
import type { FrontendTurnEngineWaitingNoteProps } from "../frontendFeatureModule";
import { CLAUDE_CODE_COPY, claudeCodeNotReadySentence } from "./claudeCodeCopy";
import {
  claudeCodeDesktopHostAvailable,
  readClaudeCodeDesktopStatus,
  readThisComputerRuntime,
} from "./claudeCodeDesktop";
import { claudeCodePlanLimitResetsAt } from "./claudeCodeTurnPresentation";

const COPY = CLAUDE_CODE_COPY.waiting;

/** What this computer can do for a turn that waits, as Desktop says it. */
type ThisComputer =
  /** Not Instafy Desktop, or one that can't run Claude Code turns: another computer runs it. */
  | { kind: "elsewhere" }
  /** Desktop could run it here once Claude Code is set up on this computer. */
  | { kind: "set_up_here" }
  /** Claude Code is set up here, and Desktop doesn't run this space. */
  | { kind: "start_here" }
  /** Desktop runs this space here, as this runtime. */
  | { kind: "runs_here"; runtimeId: string };

async function readThisComputer(
  projectId: string,
  resolveControllerUrl: () => Promise<string | null>,
): Promise<ThisComputer> {
  if (!claudeCodeDesktopHostAvailable()) {
    return { kind: "elsewhere" };
  }
  const desktop = await readClaudeCodeDesktopStatus(await resolveControllerUrl().catch(() => null));
  if (!desktop?.supported) {
    return { kind: "elsewhere" };
  }
  if (!desktop.consented) {
    return { kind: "set_up_here" };
  }
  const runtime = await readThisComputerRuntime();
  return runtime && runtime.projectId === projectId
    ? { kind: "runs_here", runtimeId: runtime.runtimeId }
    : { kind: "start_here" };
}

/**
 * What a waiting Claude Code turn's row adds for its person
 * (docs/Local-Engine-Turns.md 11.14): what makes the turn run. In Instafy
 * Desktop that is starting this space on this computer, with the existing
 * Start action, or setting Claude Code up here first; anywhere else, Instafy
 * Desktop running the space on their computer. It says nothing while their
 * Claude plan's limit holds the turn, which the line itself says, or while
 * this computer runs the space and its Claude Code is ready, when the turn
 * only waits for its lease.
 */
export function ClaudeCodeWaitingNote({
  projectId,
  runtimes,
  startOnThisComputer,
  starting,
  resolveControllerUrl,
}: FrontendTurnEngineWaitingNoteProps) {
  const [thisComputer, setThisComputer] = useState<ThisComputer | null>(() =>
    claudeCodeDesktopHostAvailable() ? null : { kind: "elsewhere" },
  );
  const generationRef = useRef(0);
  const resolveControllerUrlRef = useRef(resolveControllerUrl);
  resolveControllerUrlRef.current = resolveControllerUrl;
  // Desktop starts and stops its runtime without telling Studio; the space's
  // runtimes change when it does, and a start from here ends.
  const runtimeIdsKey = runtimes.map((entry) => entry.runtimeId).join("\u0000");

  useEffect(() => {
    const read = () => {
      const generation = ++generationRef.current;
      void readThisComputer(projectId, resolveControllerUrlRef.current).then((next) => {
        if (generation === generationRef.current) {
          setThisComputer(next);
        }
      });
    };
    read();
    if (typeof window === "undefined") {
      return () => {
        generationRef.current += 1;
      };
    }
    window.addEventListener("focus", read);
    return () => {
      generationRef.current += 1;
      window.removeEventListener("focus", read);
    };
  }, [projectId, runtimeIdsKey, starting]);

  if (!thisComputer || claudeCodePlanLimitResetsAt(runtimes) !== null) {
    return null;
  }
  const line = (text: string) => (
    <Text as="span" variant="caption" tone="muted" className="min-w-0">
      {text}
    </Text>
  );
  switch (thisComputer.kind) {
    case "elsewhere":
      return <div data-testid="claude-code-waiting-note">{line(COPY.elsewhere)}</div>;
    case "set_up_here":
      return <div data-testid="claude-code-waiting-note">{line(COPY.setUpHere)}</div>;
    case "start_here":
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-testid="claude-code-waiting-note">
          {line(COPY.startHere)}
          {startOnThisComputer ? (
            <Button
              variant="secondary"
              size="xs"
              radius="full"
              isPending={starting}
              isDisabled={starting}
              data-testid="claude-code-waiting-start"
              onPress={startOnThisComputer}
            >
              {starting ? COPY.startingAction : COPY.startAction}
            </Button>
          ) : null}
        </div>
      );
    case "runs_here": {
      // This computer runs the space: it takes the turn once its Claude Code
      // can, so the note says only what keeps it from that.
      const capability = runtimes.find((entry) => entry.runtimeId === thisComputer.runtimeId)?.claudeCode ?? null;
      if (!capability || capability.ready) {
        return null;
      }
      return <div data-testid="claude-code-waiting-note">{line(claudeCodeNotReadySentence(capability.reason))}</div>;
    }
  }
}
