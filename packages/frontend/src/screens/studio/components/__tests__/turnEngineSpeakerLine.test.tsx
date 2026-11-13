// @vitest-environment jsdom

import { act, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEngineTurnOwner } from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import {
  AgentJobThreadPreviewLayout,
  type AgentJobThreadPreviewLayoutProps,
} from "../AgentJobThreadPreviewLayout";
import { AssistantSpeakerIdentityLabel } from "../AssistantSpeakerIdentityPill";
import { RunFailureRetryProvider, type RunFailureRetryContextValue } from "../RunFailureNotice";

const JOB_ID = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";
// What only the controller writes on a Claude Code turn's reply (docs/Local-Engine-Turns.md 2.1).
const STAMPED = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
// What a client could send or record on its own.
const NOT_THE_CONTROLLERS: Array<[string, Record<string, unknown>]> = [
  ["the send's claim", { turnEngine: "claude-code" }],
  ["an access mode alone", { aiAccessMode: "claude-code" }],
  ["a stamp alone", { claudeCode: { version: 1 } }],
  ["another engine's access mode", { aiAccessMode: "byoc", claudeCode: { version: 1 } }],
];

function reply(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: "reply-1",
    role: "assistant",
    authorId: null,
    content: "Fixed the login test.",
    timestamp: 5,
    files: null,
    messageType: null,
    metadata: { source: "agent", outcome: "succeeded", jobId: JOB_ID, agent: { handle: "octo" }, ...metadata },
  };
}

function MessageContent({ content }: { content: string }) {
  return <span>{content}</span>;
}

function layoutProps(finalSummaryMessage: ChatMessage): AgentJobThreadPreviewLayoutProps {
  return {
    message: {
      id: `agent-job-thread:${JOB_ID}`,
      role: "assistant",
      authorId: null,
      content: "",
      timestamp: 0,
      files: null,
      messageType: "agent_job_thread",
      metadata: { messageType: "agent_job_thread", jobId: JOB_ID, agent: { handle: "octo" }, threadMessages: [finalSummaryMessage] },
    },
    projectId: "project-1",
    branchThreads: [],
    // As in the main transcript, where the row's speaker sits outside it.
    showHeaderAvatar: false,
    showHeaderIdentity: false,
    assistantAvatarMotion: "idle",
    activity: { live: null, summary: "Edited 2 files", stepCount: 1, details: [] },
    detailsOpen: false,
    cards: [],
    isThreadUnresolved: false,
    canCancelTerminalRun: false,
    cancelPending: false,
    expandedUpdateIds: {},
    finalSummaryMessage,
    hasPreview: true,
    previewText: finalSummaryMessage.content,
    isCompleted: true,
    shouldAnimateThreadLiveState: false,
    latestFiles: null,
    isRunning: false,
    finalSpineTone: "primary",
    threadPreviewRootRef: { current: null },
    threadPreviewRef: { current: null },
    threadPreviewRootStyle: { "--thread-spine-left": "-26px" } as CSSProperties,
    threadPreviewRailStyle: { top: "32px", bottom: "40px" },
    threadSpineJunctionOffsetClass: "left-[var(--thread-spine-left)]",
    threadSpineHeaderOffsetClass: "left-[var(--thread-header-left)]",
    onOpenBranchThread: vi.fn(),
    onToggleDetails: vi.fn(),
    onToggleUpdateExpanded: vi.fn(),
    onCancelRun: vi.fn(),
    onCancelTerminalCommand: null,
    MessageContent,
    ChatFileChangeList: () => null,
  };
}

function ownerContext(owner: TurnEngineTurnOwner | null): RunFailureRetryContextValue {
  return { pendingRetryKey: null, requestRetry: vi.fn(), autoRetryingKey: null, turnEngineOwnerOf: () => owner };
}

describe("the line under a turn-engine reply's header", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const lines = () =>
    [...container.querySelectorAll('[data-testid="turn-engine-speaker-line"]')].map((node) => node.textContent);

  describe("in a turn's row", () => {
    async function render(finalSummary: ChatMessage, context: RunFailureRetryContextValue | null = null) {
      await act(async () =>
        root.render(
          <RunFailureRetryProvider value={context}>
            <AgentJobThreadPreviewLayout {...layoutProps(finalSummary)} />
          </RunFailureRetryProvider>,
        ),
      );
    }

    it("names whose own Claude Code ran it, once, from the controller's stamp", async () => {
      await render(reply(STAMPED), ownerContext({ isViewer: false, name: "Sam" }));
      expect(lines()).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
      // The reply stays the agent's.
      expect(container.textContent).toContain("Fixed the login test.");

      await render(reply(STAMPED), ownerContext({ isViewer: true, name: "Sam" }));
      expect(lines()).toEqual(["Ran on your own Claude Code, on your computer"]);

      await render(reply(STAMPED));
      expect(lines()).toEqual(["Ran on the sender's own Claude Code, on their computer"]);
    });

    it.each(NOT_THE_CONTROLLERS)("says nothing for %s", async (_case, metadata) => {
      await render(reply(metadata), ownerContext({ isViewer: false, name: "Sam" }));
      expect(lines()).toEqual([]);
      expect(container.textContent).not.toContain("Claude Code");
    });

    it("leaves a failed turn to its failure sentence", async () => {
      const failed: ChatMessage = {
        ...reply({ ...STAMPED, outcome: "failed", messageType: "error", claudeCodeFailure: "stalled" }),
        content: "claude stopped sending events",
      };
      await render(failed, ownerContext({ isViewer: false, name: "Sam" }));
      expect(lines()).toEqual([]);
    });
  });

  describe("under the speaker's name", () => {
    async function render(metadata: Record<string, unknown>, context: RunFailureRetryContextValue | null = null) {
      await act(async () =>
        root.render(
          <RunFailureRetryProvider value={context}>
            <AssistantSpeakerIdentityLabel handle="octo" timestamp={5} metadata={reply(metadata).metadata} />
          </RunFailureRetryProvider>,
        ),
      );
    }

    it("keeps Octo the speaker and adds the plain line for a stamped reply", async () => {
      await render(STAMPED, ownerContext({ isViewer: false, name: "Sam" }));
      expect(container.querySelector('[data-testid="chat-speaker-name"]')?.textContent).toBe("Octo");
      expect(lines()).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
      // Words, not a badge or a logo.
      expect(container.querySelector('[data-testid="turn-engine-speaker-line"] img, [data-testid="turn-engine-speaker-line"] svg')).toBeNull();
    });

    it.each(NOT_THE_CONTROLLERS)("says nothing for %s", async (_case, metadata) => {
      await render(metadata, ownerContext({ isViewer: false, name: "Sam" }));
      expect(container.querySelector('[data-testid="chat-speaker-name"]')?.textContent).toBe("Octo");
      expect(lines()).toEqual([]);
    });
  });
});
