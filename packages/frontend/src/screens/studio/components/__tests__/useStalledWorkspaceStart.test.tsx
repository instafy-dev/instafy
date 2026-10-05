// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnsureHostedRuntimeOptions } from "../../../../runtime/hooks/useHostedRuntimeEnsure";
import type { ControllerRuntimeStatusEntry } from "../../../../sdk/instafy";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { WorkspaceStartStalledRow } from "../ChatSystemRows";
import { ChatTypingRows } from "../ChatTypingRows";
import {
  resolveStalledWorkspaceStart,
  useStalledWorkspaceStart,
  type StalledWorkspaceStartInput,
} from "../useStalledWorkspaceStart";

const REQUESTED_AT_MS = Date.parse("2026-10-05T12:00:00.000Z");
const MINUTE = 60_000;
const STARTING_LABEL = "Octo is starting its workspace…";
const STALLED_COPY =
  "Octo's workspace is taking longer than usual to start. Your message is kept and will send once it's running.";

const userMessage: ChatMessage = { id: "user-1", role: "user", content: "Hi", timestamp: REQUESTED_AT_MS };

function queuedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: "project-1",
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "queued",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: null,
    createdAt: new Date(REQUESTED_AT_MS).toISOString(),
    updatedAt: new Date(REQUESTED_AT_MS).toISOString(),
    ...overrides,
  };
}

function launchingRuntime(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "runtime-1",
    status: "requested",
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: null,
    launchRequestedAt: new Date(REQUESTED_AT_MS).toISOString(),
    isLocal: false,
    isPreferred: true,
    health: "offline",
    ...overrides,
  };
}

function input(overrides: Partial<StalledWorkspaceStartInput> = {}): StalledWorkspaceStartInput {
  return {
    runtimeStatuses: [launchingRuntime()],
    runtimeReady: false,
    localRuntime: false,
    conversationId: "conversation-1",
    runs: { "run-1": queuedRun() },
    messages: [userMessage],
    runtimeLimitReached: false,
    outOfCredits: false,
    ...overrides,
  };
}

// The controller's record of a reconnect the team's runtime limit refused.
const limitWaitAlert = {
  reason: "runtime_not_ready",
  reconnect: { status: "failed", code: "runtime_limit_reached" },
};

describe("resolveStalledWorkspaceStart", () => {
  const at = (minutes: number) => REQUESTED_AT_MS + minutes * MINUTE;

  it("waits five minutes from the controller's launch time, then shows the notice", () => {
    expect(resolveStalledWorkspaceStart({ ...input(), nowMs: at(4) })).toEqual({
      launchStalled: false,
      showNotice: false,
      nextCheckAtMs: at(5),
    });
    expect(resolveStalledWorkspaceStart({ ...input(), nowMs: at(5) })).toEqual({
      launchStalled: true,
      showNotice: true,
      nextCheckAtMs: null,
    });
    // An in-progress run waits on the workspace just the same.
    expect(
      resolveStalledWorkspaceStart({
        ...input({ runs: { "run-1": queuedRun({ status: "in_progress" }) } }),
        nowMs: at(6),
      }).showNotice,
    ).toBe(true);
  });

  it("never stalls when the controller does not report the launch time", () => {
    const state = resolveStalledWorkspaceStart({
      ...input({ runtimeStatuses: [launchingRuntime({ launchRequestedAt: undefined })] }),
      nowMs: at(60),
    });
    expect(state).toEqual({ launchStalled: false, showNotice: false, nextCheckAtMs: null });
  });

  it("leaves a runtime limit wait and an empty credit balance to their own messages", () => {
    const late = at(10);
    expect(resolveStalledWorkspaceStart({ ...input({ runtimeLimitReached: true }), nowMs: late }).showNotice).toBe(false);
    expect(resolveStalledWorkspaceStart({ ...input({ outOfCredits: true }), nowMs: late }).showNotice).toBe(false);
    const limitWait = resolveStalledWorkspaceStart({
      ...input({ runs: { "run-1": queuedRun({ metadata: { runtimeAlert: limitWaitAlert } }) } }),
      nowMs: late,
    });
    expect(limitWait).toEqual({ launchStalled: false, showNotice: false, nextCheckAtMs: null });
  });

  it("is quiet when the workspace is ready, local, or no message of this conversation waits", () => {
    const late = at(10);
    expect(resolveStalledWorkspaceStart({ ...input({ runtimeReady: true }), nowMs: late }).launchStalled).toBe(false);
    expect(resolveStalledWorkspaceStart({ ...input({ localRuntime: true }), nowMs: late }).launchStalled).toBe(false);

    // A run that failed for good: the AI provider refused it.
    const failedRunError: ChatMessage = {
      id: "error-1",
      role: "assistant",
      content: "insufficient_quota",
      timestamp: REQUESTED_AT_MS + 1,
      metadata: { messageType: "error", runId: "run-1" },
    };
    for (const waiting of [
      input({ runs: {} }),
      input({ runs: { "run-1": queuedRun({ conversationId: "conversation-2" }) } }),
      input({ runs: { "run-1": queuedRun({ status: "success" }) } }),
      input({ conversationId: null }),
      input({ messages: [userMessage, failedRunError] }),
      input({
        runs: {
          "run-1": queuedRun({
            // A silent skill-mode evaluation that has not spoken.
            metadata: { groupParticipation: { decision: "agent_evaluation" } },
          }),
        },
      }),
    ]) {
      const state = resolveStalledWorkspaceStart({ ...waiting, nowMs: late });
      // The launch itself is still stalled, for the queue's retry.
      expect(state).toEqual({ launchStalled: true, showNotice: false, nextCheckAtMs: null });
    }
  });
});

/**
 * ChatPanel's wiring of the notice, on its own: the hook, the typing status it
 * replaces and the notice row. ChatPanel cannot be mounted in jsdom (see
 * chatPanelRunTraceAutoRetry.test.ts), so the last test reads its source.
 */
function Harness({
  ensureHostedRuntime,
  showStatus = () => {},
  ...overrides
}: Partial<StalledWorkspaceStartInput> & {
  ensureHostedRuntime: ((options?: EnsureHostedRuntimeOptions) => Promise<boolean>) | null;
  showStatus?: (message: string, intent: "info" | "success" | "warning" | "error") => void;
}) {
  const stall = useStalledWorkspaceStart({ ...input(overrides), ensureHostedRuntime, showStatus });
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
        typingIndicatorState={{ phase: "waiting", label: null }}
        typingStatusLabel={STARTING_LABEL}
        typingStatusAriaLabel="Octo is starting its workspace"
        suppressAssistantStatus={stall.showNotice}
        isThinkingLabelExpanded={false}
        onToggleThinkingLabel={() => undefined}
        latestDisplayedMessageId={userMessage.id}
        renderAssistantAvatar={() => <span />}
      />
      {stall.showNotice ? (
        <WorkspaceStartStalledRow
          agentDisplayName="Octo"
          onRetry={stall.retry}
          retryPending={stall.retryPending}
        />
      ) : null}
    </>
  );
}

describe("stalled workspace start in the chat", () => {
  let container: HTMLDivElement;
  let root: Root;

  const notice = () => container.querySelector('[data-testid="chat-workspace-start-stalled"]');
  const retryButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="chat-workspace-start-retry"]');
  const typingStatus = () => container.querySelector('[data-testid="assistant-typing-indicator"]');

  async function render(element: ReactElement) {
    await act(async () => {
      root.render(element);
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ now: REQUESTED_AT_MS + 1_000 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("replaces the starting row with a notice once the launch passes five minutes, on a quiet tab", async () => {
    await render(<Harness ensureHostedRuntime={vi.fn(async () => true)} />);

    expect(typingStatus()?.textContent).toContain(STARTING_LABEL);
    expect(notice()).toBeNull();

    await advance(4 * MINUTE);
    expect(notice()).toBeNull();
    expect(typingStatus()?.textContent).toContain(STARTING_LABEL);

    // No new props: only the hook's own timer can bring the notice up.
    await advance(MINUTE);
    expect(notice()?.textContent).toContain(STALLED_COPY);
    expect(notice()?.textContent).not.toContain("\u2014");
    expect(notice()?.querySelector('[role="status"]')?.textContent).toBe(STALLED_COPY);
    expect(retryButton()?.textContent).toBe("Try again");
    // Not stacked under the starting row.
    expect(typingStatus()).toBeNull();
  });

  it("asks for a replacement launch on Try again, pending until the request settles", async () => {
    let settle!: (value: boolean) => void;
    const ensureHostedRuntime = vi.fn<(options?: EnsureHostedRuntimeOptions) => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const showStatus = vi.fn();
    await render(<Harness ensureHostedRuntime={ensureHostedRuntime} showStatus={showStatus} />);
    await advance(5 * MINUTE);

    await act(async () => {
      retryButton()?.click();
    });
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    expect(ensureHostedRuntime).toHaveBeenCalledWith({ force: true, replaceStalledLaunch: true });
    // The pressed button stays, pending, so keyboard focus is not dropped,
    // and a second press is ignored.
    expect(retryButton()?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      retryButton()?.click();
    });
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(true);
    });
    expect(retryButton()?.getAttribute("aria-disabled")).toBeNull();
    expect(showStatus).not.toHaveBeenCalled();

    // The new lease's start time is fresh, so the next status refresh clears
    // the notice without any clock of the client's own.
    await render(
      <Harness
        ensureHostedRuntime={ensureHostedRuntime}
        runtimeStatuses={[launchingRuntime({ launchRequestedAt: new Date(Date.now()).toISOString() })]}
      />,
    );
    expect(notice()).toBeNull();
    expect(typingStatus()?.textContent).toContain(STARTING_LABEL);
  });

  it("says so in plain words when the retry itself throws", async () => {
    const showStatus = vi.fn();
    const ensureHostedRuntime = vi.fn(async () => {
      throw new Error("network down");
    });
    await render(<Harness ensureHostedRuntime={ensureHostedRuntime} showStatus={showStatus} />);
    await advance(5 * MINUTE);

    await act(async () => {
      retryButton()?.click();
    });

    expect(showStatus).toHaveBeenCalledWith(
      "Couldn't restart the workspace yet. Try again in a minute.",
      "warning",
      5000,
    );
    expect(retryButton()?.getAttribute("aria-disabled")).toBeNull();
  });

  it("shows a read-only member the notice without a button or a claim about their message", async () => {
    await render(<Harness ensureHostedRuntime={null} />);
    await advance(5 * MINUTE);

    expect(notice()?.textContent).toContain(
      "Octo's workspace is taking longer than usual to start. Queued messages will send once it's running.",
    );
    expect(notice()?.textContent).not.toContain("Your message");
    expect(retryButton()).toBeNull();
  });

  it("shows no notice for a runtime limit wait, an empty credit balance or an older controller", async () => {
    for (const overrides of [
      { runtimeLimitReached: true },
      { runs: { "run-1": queuedRun({ metadata: { runtimeAlert: limitWaitAlert } }) } },
      { outOfCredits: true },
      { runtimeStatuses: [launchingRuntime({ launchRequestedAt: undefined })] },
    ] satisfies Partial<StalledWorkspaceStartInput>[]) {
      await render(<Harness ensureHostedRuntime={vi.fn(async () => true)} {...overrides} />);
      await advance(30 * MINUTE);
      expect(notice()).toBeNull();
      expect(typingStatus()?.textContent).toContain(STARTING_LABEL);
    }
  });

  it("is wired into ChatPanel the same way", () => {
    const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
    const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

    expect(chatPanel).toContain("useStalledWorkspaceStart({");
    expect(chatPanel).toContain("runtimeLimitReached: Boolean(runtimeEnsureLimit?.limitReached),");
    expect(chatPanel).toContain("ensureHostedRuntime: projectWriteDisabled ? null : ensureHostedRuntime,");
    expect(chatPanel).toContain(
      "suppressAssistantStatus={showOutOfCreditsNotice || workspaceStartStall.showNotice}",
    );
    expect(chatPanel).toContain("onRetry={workspaceStartStall.retry}");
    // The notice takes the typing status's place, right after it.
    const typingRows = chatPanel.indexOf("<ChatTypingRows");
    const stalledRow = chatPanel.indexOf("<WorkspaceStartStalledRow");
    expect(typingRows).toBeGreaterThan(-1);
    expect(stalledRow).toBeGreaterThan(typingRows);
    expect(chatPanel.slice(typingRows, stalledRow)).not.toContain("</ChatColumn>");
  });
});
