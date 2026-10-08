// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";

const mocks = vi.hoisted(() => ({
  versioning: { mode: "stateless", recovery: "supported" } as { mode: string; recovery: string },
}));

vi.mock("../../../../workspace/useActiveWorkspaceVersioning", () => ({
  useActiveWorkspaceVersioning: () => mocks.versioning,
}));

import {
  clearIdlePaused,
  clearManualStop,
  markIdlePaused,
  markManualStop,
  recordManualStopFlush,
} from "../../../../runtime/idlePauseRegistry";
import { isRunActivelyProgressing } from "../../../../conversations/runLiveness";
import { StoppedTurnRow } from "../ChatSystemRows";
import { ChatTypingRows } from "../ChatTypingRows";
import {
  hasStoppedTurn,
  resolveStoppedTurn,
  useStoppedTurnNotice,
  type StoppedTurnInput,
} from "../useStoppedTurnNotice";

const PROJECT_ID = "project-stopped-turn";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const STOPPED_COPY = "Octo was stopped before finishing. It picks up again when the machine starts.";
const KEPT_IN_HISTORY = "Any unsaved changes are kept under History, in Unsaved work.";
/** The stop's flush pushed everything it kept, so History lists it. */
const SAVED_FLUSH = { status: "flushed", unpushedRefs: 0, error: null };
const THINKING_LABEL = "Running sleep 120";

const userMessage: ChatMessage = { id: "user-1", role: "user", content: "Make a todo list", timestamp: NOW };

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: PROJECT_ID,
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "in_progress",
    progress: 40,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: { agentIdentity: { handle: "octo" } },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/**
 * The run as a controller that records the stop returns it, live and after a
 * reload: queued again at stage "requeued", with the stop's reason.
 */
function requeued(reason = "user_stop", overrides: Partial<RunRecord> = {}): RunRecord {
  return run({
    status: "queued",
    progressStage: "requeued",
    metadata: {
      agentIdentity: { handle: "octo" },
      interruption: {
        reason,
        jobId: "job-1",
        interruptedAt: new Date(NOW + 30_000).toISOString(),
        resumeBy: new Date(NOW + 30_000 + 15 * 60_000).toISOString(),
      },
    },
    updatedAt: new Date(NOW + 30_000).toISOString(),
    ...overrides,
  });
}

/** The same run once a machine picked it up again: the record stays as history. */
function resumed(): RunRecord {
  return { ...requeued(), status: "in_progress", progressStage: "agent:leased" };
}

/** Every reason a person's stop sends: Stop, Remove, and both takeovers of the machine's slot. */
const PERSON_STOP_REASONS = [
  "user_stop",
  "user_remove",
  "runtime_limit_takeover",
  "browser_session_runtime_limit_takeover",
];
/** Stops nobody chose, as the controller names them, and an unnamed or unknown one. */
const OTHER_STOP_REASONS = [
  "idle_stop",
  "credits_exhausted",
  "heartbeat_timeout",
  "pool_retirement_drain",
  "dev_runtime_offline",
  "other",
  "",
];

function input(overrides: Partial<StoppedTurnInput> = {}): StoppedTurnInput {
  return {
    manualStopAt: NOW + 60_000,
    runtimeReady: false,
    activeRuns: [run()],
    messages: [userMessage],
    ...overrides,
  };
}

describe("hasStoppedTurn", () => {
  it("is a started run with no machine left after the person's Stop", () => {
    expect(hasStoppedTurn(input())).toBe(true);
    expect(hasStoppedTurn(input({ activeRuns: [run({ status: "awaiting_approval" })] }))).toBe(true);
  });

  it("is nothing without a Stop, while a machine is ready, or for a run that had not started", () => {
    // No Stop in this tab: an idle pause between turns holds differently.
    expect(hasStoppedTurn(input({ manualStopAt: null }))).toBe(false);
    // Stop is still on its way, or another machine runs the turn.
    expect(hasStoppedTurn(input({ runtimeReady: true }))).toBe(false);
    expect(hasStoppedTurn(input({ activeRuns: [run({ status: "queued" })] }))).toBe(false);
    expect(hasStoppedTurn(input({ activeRuns: [] }))).toBe(false);
  });

  it("is nothing for a turn that began after the Stop, or one with no known start", () => {
    // The hold outlives the Stop while a machine that came back without asking
    // through this tab (a Desktop runtime, another tab) runs later turns.
    expect(hasStoppedTurn(input({ activeRuns: [run({ createdAt: new Date(NOW + 120_000).toISOString() })] }))).toBe(
      false,
    );
    expect(hasStoppedTurn(input({ activeRuns: [run({ createdAt: null })] }))).toBe(false);
    expect(hasStoppedTurn(input({ activeRuns: [run({ createdAt: "soon" })] }))).toBe(false);
    expect(hasStoppedTurn(input({ manualStopAt: NOW }))).toBe(true);
  });

  it("is nothing for a finished run", () => {
    for (const status of ["success", "failed", "canceled"] as const) {
      expect(hasStoppedTurn(input({ activeRuns: [run({ status })] }))).toBe(false);
    }
  });

  it("is nothing for a silent skill-mode evaluation", () => {
    const silent = run({ metadata: { groupParticipation: { decision: "agent_evaluation" } } });
    expect(hasStoppedTurn(input({ activeRuns: [silent] }))).toBe(false);
    const silentRecord = requeued("user_stop", {
      metadata: { ...requeued().metadata, groupParticipation: { decision: "agent_evaluation" } },
    });
    expect(hasStoppedTurn(input({ manualStopAt: null, activeRuns: [silentRecord] }))).toBe(false);
  });
});

describe("resolveStoppedTurn, from the controller's record of the stop", () => {
  it("is every viewer's when someone's stop put the turn back in the queue", () => {
    for (const reason of PERSON_STOP_REASONS) {
      expect(resolveStoppedTurn(input({ manualStopAt: null, activeRuns: [requeued(reason)] }))).toBe("recorded");
    }
    expect(resolveStoppedTurn(input({ manualStopAt: null, activeRuns: [requeued(" User_Stop ")] }))).toBe("recorded");
    // Not while a machine is ready to pick it up.
    expect(resolveStoppedTurn(input({ manualStopAt: null, runtimeReady: true, activeRuns: [requeued()] }))).toBeNull();
  });

  it("is this tab's when its own Stop came after the turn started", () => {
    expect(resolveStoppedTurn(input({ activeRuns: [requeued()] }))).toBe("held");
    // The old shape before the record arrives, or from an older controller.
    expect(resolveStoppedTurn(input())).toBe("held");
    // This tab's hold is older than the turn, so someone else's stop cut it off.
    expect(resolveStoppedTurn(input({ manualStopAt: NOW - 60_000, activeRuns: [requeued()] }))).toBe("recorded");
    expect(resolveStoppedTurn(input({ manualStopAt: NOW - 60_000, activeRuns: [run()] }))).toBeNull();
  });

  it("is nothing for a stop nobody chose, even in the tab that holds a Stop", () => {
    for (const reason of OTHER_STOP_REASONS) {
      expect(resolveStoppedTurn(input({ manualStopAt: null, activeRuns: [requeued(reason)] }))).toBeNull();
      expect(resolveStoppedTurn(input({ activeRuns: [requeued(reason)] }))).toBeNull();
    }
  });

  it("is nothing outside that exact shape, or once a machine picked the turn up", () => {
    const noHold = (activeRuns: RunRecord[]) => resolveStoppedTurn(input({ manualStopAt: null, activeRuns }));
    expect(noHold([requeued("user_stop", { progressStage: "agent:queued" })])).toBeNull();
    expect(noHold([requeued("user_stop", { metadata: { interruption: "user_stop" } })])).toBeNull();
    expect(noHold([requeued("user_stop", { metadata: null })])).toBeNull();
    // The lease moves the run on and leaves the record behind as history.
    expect(noHold([resumed()])).toBeNull();
    expect(resolveStoppedTurn(input({ runtimeReady: true, activeRuns: [resumed()] }))).toBeNull();
  });
});

/**
 * ChatPanel's wiring, on its own: the hook, the typing status it replaces and
 * the line. ChatPanel cannot be mounted in jsdom (see
 * chatPanelRunTraceAutoRetry.test.ts), so the last test reads its source.
 */
function Harness({
  runtimeReady = false,
  activeRuns = [run()],
  agentDisplayName = "Octo",
}: {
  runtimeReady?: boolean;
  activeRuns?: RunRecord[];
  agentDisplayName?: string | null;
}) {
  const stoppedTurnNotice = useStoppedTurnNotice({
    projectId: PROJECT_ID,
    runtimeReady,
    activeRuns,
    messages: [userMessage],
    agentDisplayName,
  });
  return (
    <>
      <ChatTypingRows
        peerTypingLabel={null}
        isAssistantTyping
        isAssistantTypingCoveredByJobThreadPreview={false}
        typingAgents={[]}
        hasMultipleTypingAgents={false}
        typingAgentHandle="octo"
        typingAgentAvatarSeed="octo"
        typingIndicatorState={{ phase: "thinking", label: THINKING_LABEL }}
        typingStatusLabel="Thinking…"
        typingStatusAriaLabel="Octo is thinking"
        suppressAssistantStatus={stoppedTurnNotice !== null}
        isThinkingLabelExpanded={false}
        onToggleThinkingLabel={() => undefined}
        latestDisplayedMessageId={userMessage.id}
        renderAssistantAvatar={() => <span />}
      />
      {stoppedTurnNotice ? <StoppedTurnRow text={stoppedTurnNotice} /> : null}
    </>
  );
}

describe("a turn the person's Stop cut off, in the chat", () => {
  let container: HTMLDivElement;
  let root: Root;

  const line = () => container.querySelector('[data-testid="chat-stopped-turn"]');
  const typingStatus = () => container.querySelector('[data-testid="assistant-typing-indicator"]');

  async function render(element: ReactElement) {
    await act(async () => root.render(element));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.versioning = { mode: "stateless", recovery: "supported" };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearManualStop(PROJECT_ID);
    clearIdlePaused(PROJECT_ID);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("replaces the typing status with one calm line once Stop holds the machine, and steps back on Start", async () => {
    await render(<Harness />);
    expect(line()).toBeNull();
    expect(typingStatus()?.textContent).toContain(THINKING_LABEL);

    const hold = markManualStop(PROJECT_ID);
    await render(<Harness />);
    expect(line()?.textContent).toBe(STOPPED_COPY);
    expect(line()?.getAttribute("role")).toBe("status");
    expect(typingStatus()).toBeNull();

    // History lists the turn's unsaved work once the stop's flush pushed it.
    await act(async () => recordManualStopFlush(PROJECT_ID, hold, SAVED_FLUSH));
    expect(line()?.textContent).toBe(`${STOPPED_COPY} ${KEPT_IN_HISTORY}`);

    // Start or a send lifts the hold, and a machine that comes back picks the turn up again.
    await act(async () => clearManualStop(PROJECT_ID));
    expect(line()).toBeNull();
    expect(typingStatus()?.textContent).toContain(THINKING_LABEL);
  });

  it("shows nothing for an idle pause, a ready machine or a run that had not started", async () => {
    markIdlePaused(PROJECT_ID);
    await render(<Harness />);
    expect(line()).toBeNull();

    await act(async () => markManualStop(PROJECT_ID));
    await render(<Harness runtimeReady />);
    expect(line()).toBeNull();
    await render(<Harness activeRuns={[run({ status: "queued" })]} />);
    expect(line()).toBeNull();
    await render(<Harness activeRuns={[]} />);
    expect(line()).toBeNull();
  });

  it("says nothing about a later turn after a machine came back without lifting the hold", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      // Machines > Stop on the last hosted machine while the Desktop runtime
      // keeps the space working; its sends never lift the hold.
      now.mockReturnValueOnce(NOW + 1_000);
      markManualStop(PROJECT_ID);
      const later = run({ id: "run-2", createdAt: new Date(NOW + 60_000).toISOString() });
      await render(<Harness runtimeReady activeRuns={[later]} />);
      expect(line()).toBeNull();

      // Mid-turn the Desktop app restarts: the job is requeued, and the run
      // still reads as in progress. Nobody stopped this turn.
      await render(<Harness activeRuns={[later]} />);
      expect(line()).toBeNull();
      expect(typingStatus()?.textContent).toContain(THINKING_LABEL);

      // A turn the Stop did cut off still says so.
      await render(<Harness activeRuns={[run(), later]} />);
      expect(line()?.textContent).toBe(STOPPED_COPY);

      // A later Stop that again leaves no machine is the one that cut it off.
      now.mockReturnValueOnce(NOW + 120_000);
      markManualStop(PROJECT_ID);
      await render(<Harness activeRuns={[later]} />);
      expect(line()?.textContent).toBe(STOPPED_COPY);
    } finally {
      now.mockRestore();
    }
  });

  it("names History only once the stop's flush pushed all of the turn's work", async () => {
    const hold = markManualStop(PROJECT_ID);
    await render(<Harness />);
    expect(line()?.textContent).toBe(STOPPED_COPY);

    // Otherwise the work waits on the machine's disk until the next start pushes it.
    for (const flush of [
      { status: "flushed", unpushedRefs: 1, error: null },
      { status: "flushed", unpushedRefs: null, error: null },
      { status: "failed", unpushedRefs: null, error: "origin_timeout" },
      { status: "no_writer", unpushedRefs: null, error: null },
      { status: "not_running", unpushedRefs: null, error: null },
    ]) {
      await act(async () => recordManualStopFlush(PROJECT_ID, hold, flush));
      expect(line()?.textContent).toBe(STOPPED_COPY);
    }

    await act(async () => recordManualStopFlush(PROJECT_ID, hold, SAVED_FLUSH));
    expect(line()?.textContent).toBe(`${STOPPED_COPY} ${KEPT_IN_HISTORY}`);
  });

  it("names no place where History lists no Unsaved work, and no agent when several work", async () => {
    recordManualStopFlush(PROJECT_ID, markManualStop(PROJECT_ID), SAVED_FLUSH);
    mocks.versioning = { mode: "legacy", recovery: "unknown" };
    await render(<Harness />);
    expect(line()?.textContent).toBe(STOPPED_COPY);

    mocks.versioning = { mode: "desktop", recovery: "supported" };
    await render(<Harness agentDisplayName={null} />);
    expect(line()?.textContent).toBe(
      `The agents were stopped before finishing. They pick up again when the machine starts. ${KEPT_IN_HISTORY}`,
    );
  });

  it("shows every viewer the lead sentence from the controller's record, also after a reload", async () => {
    // No hold: another viewer, or this tab after a reload. History may list
    // unsaved work here, but only the tab whose stop answered knows.
    await render(<Harness activeRuns={[requeued()]} />);
    expect(line()?.textContent).toBe(STOPPED_COPY);
    expect(line()?.getAttribute("role")).toBe("status");
    expect(typingStatus()).toBeNull();

    // A reload under a controller that records nothing finds a turn still in progress.
    await render(<Harness activeRuns={[run()]} />);
    expect(line()).toBeNull();
    expect(typingStatus()?.textContent).toContain(THINKING_LABEL);
  });

  it("stays for the whole wait the controller gives the turn, not five minutes", async () => {
    // ChatPanel keeps only live runs (activeConversationRuns).
    const tenMinutesOn = NOW + 30_000 + 10 * 60_000;
    const live = [requeued()].filter((candidate) => isRunActivelyProgressing(candidate, tenMinutesOn));
    await render(<Harness activeRuns={live} />);
    expect(line()?.textContent).toBe(STOPPED_COPY);
  });

  it("keeps what this tab's stop kept once the controller's record arrives", async () => {
    recordManualStopFlush(PROJECT_ID, markManualStop(PROJECT_ID), SAVED_FLUSH);
    await render(<Harness />);
    expect(line()?.textContent).toBe(`${STOPPED_COPY} ${KEPT_IN_HISTORY}`);

    await render(<Harness activeRuns={[requeued()]} />);
    expect(line()?.textContent).toBe(`${STOPPED_COPY} ${KEPT_IN_HISTORY}`);

    // Start or a send in this tab lifts the hold, and the record still explains the wait.
    await act(async () => clearManualStop(PROJECT_ID));
    expect(line()?.textContent).toBe(STOPPED_COPY);
  });

  it("steps back once a machine picks the turn up again", async () => {
    await render(<Harness activeRuns={[requeued()]} />);
    expect(line()?.textContent).toBe(STOPPED_COPY);

    await render(<Harness runtimeReady activeRuns={[resumed()]} />);
    expect(line()).toBeNull();
    expect(typingStatus()?.textContent).toContain(THINKING_LABEL);
    // Still nothing while this tab's runtime status catches up.
    await render(<Harness activeRuns={[resumed()]} />);
    expect(line()).toBeNull();
  });

  it("says nothing for a stop nobody chose", async () => {
    for (const reason of OTHER_STOP_REASONS) {
      await render(<Harness activeRuns={[requeued(reason)]} />);
      expect(line()).toBeNull();
      expect(typingStatus()?.textContent).toContain(THINKING_LABEL);
    }
  });

  it("is wired into ChatPanel the same way", () => {
    const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
    const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

    expect(chatPanel).toContain("useStoppedTurnNotice({");
    expect(chatPanel).toContain("activeRuns: activeConversationRuns,");
    expect(chatPanel).toContain("agentDisplayName: hasMultipleTypingAgents ? null : typingAgentDisplayName,");
    expect(chatPanel).toContain(
      "showOutOfCreditsNotice || workspaceStartStall.showNotice || stoppedTurnNotice !== null",
    );
    // The line takes the typing status's place, right after it.
    const typingRows = chatPanel.indexOf("<ChatTypingRows");
    const stoppedRow = chatPanel.indexOf("<StoppedTurnRow");
    expect(typingRows).toBeGreaterThan(-1);
    expect(stoppedRow).toBeGreaterThan(typingRows);
    expect(chatPanel.slice(typingRows, stoppedRow)).not.toContain("</ChatColumn>");

    // Machines > Stop keeps what the stop answered next to the hold it set.
    const provider = fs.readFileSync(path.resolve(componentsDir, "../../../runtime/RuntimeOperationsProvider.tsx"), "utf8");
    expect(provider).toContain("const hold = holdManualStop ? markManualStop(projectId) : null;");
    expect(provider).toContain("recordManualStopFlush(projectId, hold, stopped?.flush ?? null);");
  });
});
