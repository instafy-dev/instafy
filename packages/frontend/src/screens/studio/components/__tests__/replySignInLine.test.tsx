// @vitest-environment jsdom

import { act, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Registers the application's turn engines, as the application does at startup.
import "../../../../features/applicationFrontendFeatureComposition";
import type { TurnEngineTurnOwner } from "../../../../conversations/runFailurePresentation";
import {
  resetViewerConnectionsForTests,
  setViewerConnections,
} from "../../../../conversations/aiSignIns";
import { setClaudeCodeLoginsLoaderForTests } from "../../../../features/claudeCode/claudeCodeLoginsStore";
import type { ControllerCredentialListItem } from "../../../../services/runtimeController/credentials";
import type { ChatMessage } from "../../types";
import {
  AgentJobThreadPreviewLayout,
  type AgentJobThreadPreviewLayoutProps,
} from "../AgentJobThreadPreviewLayout";
import { AssistantSpeakerIdentityLabel } from "../AssistantSpeakerIdentityPill";
import { RunFailureRetryProvider, useReplySignInLineGate, type RunFailureRetryContextValue } from "../RunFailureNotice";

// docs/Local-Engine-Turns.md 11.20, D51: under a reply, its owner alone reads
// which of their sign-ins ran it, once they have more than one.

const JOB_ID = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";
const WORK = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const HOME_LOGIN = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Home", createdAt: "2026-11-01T09:00:00Z" };
const STUDIO_LOGIN = { id: "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02", label: "Studio", createdAt: "2026-11-02T09:00:00Z" };

function connection(id: string, label: string): ControllerCredentialListItem {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: null,
    lastUsedAt: null, revokedAt: null, createdAt: "", updatedAt: "",
  } as ControllerCredentialListItem;
}

function reply(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: "reply-1",
    role: "assistant",
    authorId: null,
    content: "Fixed the login test.",
    timestamp: 5,
    files: null,
    messageType: null,
    metadata: { source: "agent", outcome: "succeeded", jobId: JOB_ID, agent: { handle: "reviewer" }, aiAccessMode: "byoc", ...metadata },
  };
}

function ownerContext(owner: TurnEngineTurnOwner | null): RunFailureRetryContextValue {
  return { pendingRetryKey: null, requestRetry: vi.fn(), autoRetryingKey: null, turnEngineOwnerOf: () => owner };
}

const VIEWER = { isViewer: true, name: "Ada" };
const TEAMMATE = { isViewer: false, name: "Ada" };

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
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
      metadata: { messageType: "agent_job_thread", jobId: JOB_ID, agent: { handle: "reviewer" }, threadMessages: [finalSummaryMessage] },
    },
    projectId: "project-1",
    branchThreads: [],
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
    MessageContent: ({ content }: { content: string }) => <span>{content}</span>,
    ChatFileChangeList: () => null,
  };
}

describe("the line under a reply that names the sign-in it ran on", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [] }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const lines = () =>
    [...container.querySelectorAll('[data-testid="turn-engine-speaker-line"]')].map((node) => node.textContent);

  async function renderHeader(message: ChatMessage, owner: TurnEngineTurnOwner | null) {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext(owner)}>
          <AssistantSpeakerIdentityLabel handle="reviewer" timestamp={message.timestamp} metadata={message.metadata as Record<string, unknown>} />
        </RunFailureRetryProvider>,
      );
      await flush();
    });
  }

  it("names the viewer's own connection under their reply once they have two sign-ins", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    await renderHeader(reply({ aiSignIn: { credentialId: WORK } }), VIEWER);
    expect(lines()).toEqual(["Ran on Work ChatGPT"]);
    await renderHeader(reply({ aiSignIn: { credentialId: PERSONAL, backup: true } }), VIEWER);
    expect(lines()).toEqual(["Ran on Personal, a backup"]);
  });

  it("says nothing to anyone else, nor of a sign-in that is not the viewer's", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    await renderHeader(reply({ aiSignIn: { credentialId: WORK } }), TEAMMATE);
    expect(container.querySelector('[data-testid="chat-speaker-name"]')?.textContent).toBe("reviewer");
    expect(lines()).toEqual([]);
    // A teammate's own turn names their sign-in, which is not one of the viewer's.
    await renderHeader(reply({ aiSignIn: { credentialId: "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e99" } }), null);
    expect(lines()).toEqual([]);
    // A reply with no stamp says nothing either.
    await renderHeader(reply({}), VIEWER);
    expect(lines()).toEqual([]);
  });

  it("counts the viewer's logins with their connections", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    await renderHeader(reply({ aiSignIn: { credentialId: WORK } }), VIEWER);
    // One connection and no login: nothing to tell apart.
    expect(lines()).toEqual([]);

    await act(async () => root.render(null));
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [HOME_LOGIN] }));
    await renderHeader(reply({ aiSignIn: { credentialId: WORK } }), VIEWER);
    expect(lines()).toEqual(["Ran on Work ChatGPT"]);
  });

  it("keeps a Claude Code reply's own line, saying when a backup login ran it", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [HOME_LOGIN, STUDIO_LOGIN] }));
    const claudeCodeReply = reply({
      aiAccessMode: "claude-code",
      claudeCode: { version: 1, loginId: STUDIO_LOGIN.id },
      aiSignIn: { claudeCodeLoginId: STUDIO_LOGIN.id, backup: true },
    });
    await renderHeader(claudeCodeReply, VIEWER);
    expect(lines()).toEqual(["Ran on your own Claude Code (Studio), a backup, on your computer"]);
    await renderHeader(claudeCodeReply, TEAMMATE);
    expect(lines()).toEqual(["Ran on Ada's own Claude Code, on their computer"]);
    // Its first AI: the line as 11.19 has it.
    await renderHeader(
      reply({ aiAccessMode: "claude-code", claudeCode: { version: 1, loginId: HOME_LOGIN.id }, aiSignIn: { claudeCodeLoginId: HOME_LOGIN.id } }),
      VIEWER,
    );
    expect(lines()).toEqual(["Ran on your own Claude Code (Home), on your computer"]);
  });

  it("shows in a turn's row too, under its header", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext(VIEWER)}>
          <AgentJobThreadPreviewLayout {...layoutProps(reply({ aiSignIn: { credentialId: PERSONAL, backup: true } }))} />
        </RunFailureRetryProvider>,
      );
      await flush();
    });
    expect(lines()).toEqual(["Ran on Personal, a backup"]);
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext(TEAMMATE)}>
          <AgentJobThreadPreviewLayout {...layoutProps(reply({ aiSignIn: { credentialId: PERSONAL, backup: true } }))} />
        </RunFailureRetryProvider>,
      );
      await flush();
    });
    expect(lines()).toEqual([]);
  });

  it("tells the rows that lay out by it which replies show it", async () => {
    let gate: ((metadata: unknown) => boolean) | null = null;
    function Rows({ messages }: { messages: ChatMessage[] }) {
      gate = useReplySignInLineGate(messages);
      return null;
    }
    const own = reply({ aiSignIn: { credentialId: WORK } });
    const plain = reply({});
    const failed = reply({ outcome: "failed", messageType: "error", aiSignIn: { credentialId: WORK } });
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    await act(async () => {
      root.render(<Rows messages={[own, plain, failed]} />);
      await flush();
    });
    expect(gate!(own.metadata)).toBe(true);
    expect(gate!(plain.metadata)).toBe(false);
    // A failure shows its own block instead.
    expect(gate!(failed.metadata)).toBe(false);
    // The viewer's connections change: the rows read again.
    await act(async () => {
      setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
      await flush();
    });
    expect(gate!(own.metadata)).toBe(false);
  });
});
