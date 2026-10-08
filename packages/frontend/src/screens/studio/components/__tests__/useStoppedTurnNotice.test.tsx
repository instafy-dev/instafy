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
} from "../../../../runtime/idlePauseRegistry";
import { StoppedTurnRow } from "../ChatSystemRows";
import { ChatTypingRows } from "../ChatTypingRows";
import { hasStoppedTurn, useStoppedTurnNotice, type StoppedTurnInput } from "../useStoppedTurnNotice";

const PROJECT_ID = "project-stopped-turn";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const STOPPED_COPY =
  "Octo was stopped before finishing. Any unsaved changes are kept under History, in Unsaved work.";
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

function input(overrides: Partial<StoppedTurnInput> = {}): StoppedTurnInput {
  return {
    manualStopHeld: true,
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
    expect(hasStoppedTurn(input({ manualStopHeld: false }))).toBe(false);
    // Stop is still on its way, or another machine runs the turn.
    expect(hasStoppedTurn(input({ runtimeReady: true }))).toBe(false);
    expect(hasStoppedTurn(input({ activeRuns: [run({ status: "queued" })] }))).toBe(false);
    expect(hasStoppedTurn(input({ activeRuns: [] }))).toBe(false);
  });

  it("is nothing for a finished run", () => {
    for (const status of ["success", "failed", "canceled"] as const) {
      expect(hasStoppedTurn(input({ activeRuns: [run({ status })] }))).toBe(false);
    }
  });

  it("is nothing for a silent skill-mode evaluation", () => {
    const silent = run({ metadata: { groupParticipation: { decision: "agent_evaluation" } } });
    expect(hasStoppedTurn(input({ activeRuns: [silent] }))).toBe(false);
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

    await act(async () => markManualStop(PROJECT_ID));
    expect(line()?.textContent).toBe(STOPPED_COPY);
    expect(line()?.getAttribute("role")).toBe("status");
    expect(typingStatus()).toBeNull();

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

  it("names no place where History lists no Unsaved work, and no agent when several work", async () => {
    markManualStop(PROJECT_ID);
    mocks.versioning = { mode: "legacy", recovery: "unknown" };
    await render(<Harness />);
    expect(line()?.textContent).toBe("Octo was stopped before finishing.");

    mocks.versioning = { mode: "desktop", recovery: "supported" };
    await render(<Harness agentDisplayName={null} />);
    expect(line()?.textContent).toBe(
      "The agents were stopped before finishing. Any unsaved changes are kept under History, in Unsaved work.",
    );
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
  });
});
