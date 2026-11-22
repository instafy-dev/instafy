// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRunFailureRetryMetadata,
  type TurnEngineTurnOwner,
} from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import type { AssistantAgentIdentity } from "../chatAssistantIdentity";
import {
  collapseLifecycleMessages,
  shouldDisplayChatMessage,
  synthesizeAgentJobThreadMessages,
} from "../chatMessagePresentation";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { RunFailureRetryProvider, type RunFailureRetryContextValue } from "../RunFailureNotice";

// docs/Local-Engine-Turns.md 5.7: a Claude Code turn's reply says whose own
// Claude Code ran it, in one plain line under its header. A reply with no turn
// row (a turn that used no tools) whose header the chat leaves out (a quiet
// reply in a chat of one, or the same speaker again) still says it.

const userInputRequests = vi.hoisted(() => ({ getUserInputRequest: vi.fn(), answerUserInputRequest: vi.fn() }));
vi.mock("../../../../services/runtimeController/userInputRequests", () => userInputRequests);

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ activeConversation: null, conversations: [] }),
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1" }),
}));

vi.mock("../../../../runtime/useRuntimeMenu", () => ({
  useRuntimeMenuOptions: () => ({ runtime: { effectiveRuntimeId: null, preferredRuntimeId: null } }),
}));

vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({ activeConversationId: "conversation-local", agentHandles: [] }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openConversationTab: vi.fn(), openJobThreadTab: vi.fn(), requestUrlPush: vi.fn() }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runs: [] }),
}));

const STAMPED = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
const AT = Date.UTC(2026, 10, 13, 10);

function reply(id: string, minute: number, metadata: Record<string, unknown> = STAMPED): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: `Reply ${id}`,
    timestamp: AT + minute * 60_000,
    files: null,
    messageType: null,
    metadata: { source: "agent", outcome: "succeeded", agent: { handle: "octo" }, ...metadata },
  };
}

function ownerContext(owner: TurnEngineTurnOwner | null): RunFailureRetryContextValue {
  return { pendingRetryKey: null, requestRetry: vi.fn(), autoRetryingKey: null, turnEngineOwnerOf: () => owner };
}

describe("a turn-engine reply whose header the chat leaves out", () => {
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

  async function render(messages: ChatMessage[], identityLayout: "solo" | "participants") {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext({ isViewer: false, name: "Sam" })}>
          <ConversationMessageRows
            identityLayout={identityLayout}
            messages={messages}
            currentUserId="user-1"
            chatClientSessionId="session-1"
            projectId="project-1"
            runtimeId={null}
            conversationLocalId="conversation-local"
            conversationControllerId="conversation-controller"
            firstPlanMessageId={null}
            humanLabelByUserId={new Map()}
            runAgentIdentityByRunId={new Map()}
            runAgentHandleByRunId={new Map()}
            renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
            assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
            onRequestActions={vi.fn()}
            onRequestActionsAtPoint={vi.fn()}
            onCancelTerminalCommand={null}
            onMessageContextMenu={vi.fn()}
          />
        </RunFailureRetryProvider>,
      );
    });
  }

  const linesOf = (messageId: string) =>
    [
      ...container.querySelectorAll(
        `[data-chat-scroll-message-id="${messageId}"] [data-testid="turn-engine-speaker-line"]`,
      ),
    ].map((node) => node.textContent);

  it("still names whose own Claude Code ran it in a chat of one", async () => {
    await render([reply("reply-1", 0)], "solo");
    // The header stays out, as for any quiet reply.
    expect(container.querySelector('[data-testid="chat-speaker-name"]')).toBeNull();
    expect(linesOf("reply-1")).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
  });

  it("says it once for each reply of the same speaker, with or without a header", async () => {
    await render([reply("reply-1", 0), reply("reply-2", 1)], "participants");
    // The first reply's header carries the line; the second has none of its own.
    expect(container.querySelector('[data-chat-scroll-message-id="reply-1"] [data-testid="chat-speaker-name"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-scroll-message-id="reply-2"] [data-testid="chat-speaker-name"]')).toBeNull();
    expect(linesOf("reply-1")).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
    expect(linesOf("reply-2")).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
  });

  it("adds nothing to a reply the controller did not stamp", async () => {
    await render([reply("reply-1", 0, { aiAccessMode: "claude-code" }), reply("reply-2", 1, {})], "solo");
    expect(container.querySelectorAll('[data-testid="turn-engine-speaker-line"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-speaker-inline"]')).toBeNull();
  });
});

// Local trial, Nov 20: @cctrial, an agent its person set to Claude Code, took
// a turn whose pre-flight failed. Its failure, its "Trying again…" after Try
// again and the reply of the second try all read as Octo's, with Octo's face:
// a turn's row named no agent, so the chat fell back to Octo. Each message of
// the turn names the agent, as the controller stamps it from the job
// (docs/Local-Engine-Turns.md 5.7, 11.14).
describe("a Claude Code turn of an agent of the person's own", () => {
  const CCTRIAL = { id: "agent-cctrial", handle: "cctrial", displayName: "CC Trial", avatarSeed: "hatchling:5" };
  const WORDS = "@cctrial Hi! In one short sentence, say which AI you are.";
  const FAILED_JOB = "job-failed";
  const FAILED_RUN = "run-failed";
  const RETRY_JOB = "job-retry";
  const RETRY_RUN = "run-retry";

  function at(minute: number): number {
    return AT + minute * 60_000;
  }

  const prompt: ChatMessage = {
    id: "prompt",
    role: "user",
    authorId: "user-1",
    content: WORDS,
    timestamp: at(0),
    files: null,
    messageType: null,
    metadata: { runId: FAILED_RUN },
  };
  const failure: ChatMessage = {
    id: "failure",
    role: "assistant",
    authorId: null,
    content: "Instafy couldn't check this space's folder: git couldn't list this space's files.",
    timestamp: at(1),
    files: null,
    messageType: "error",
    metadata: {
      ...STAMPED,
      source: "agent",
      outcome: "failed",
      messageType: "error",
      provider: "claude-code",
      jobId: FAILED_JOB,
      runId: FAILED_RUN,
      claudeCodeFailure: "preflight_failed",
      agent: CCTRIAL,
    },
  };
  const resend: ChatMessage = {
    id: "resend",
    role: "user",
    authorId: "user-1",
    content: WORDS,
    timestamp: at(2),
    files: null,
    messageType: null,
    metadata: { runId: RETRY_RUN, prompt_metadata: buildRunFailureRetryMetadata(failure) },
  };
  const retryReply: ChatMessage = {
    id: "retry-reply",
    role: "assistant",
    authorId: null,
    content: "I'm Claude, working in the folder of this space.",
    timestamp: at(3),
    files: null,
    messageType: null,
    metadata: {
      ...STAMPED,
      source: "agent",
      outcome: "succeeded",
      provider: "claude-code",
      jobId: RETRY_JOB,
      runId: RETRY_RUN,
      agent: CCTRIAL,
    },
  };

  let container: HTMLDivElement;
  let root: Root;
  let faces: Array<AssistantAgentIdentity | null>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    faces = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // The chat's rows as ChatPanel builds them from the conversation's messages.
  async function renderChat(messages: ChatMessage[]) {
    const all = collapseLifecycleMessages(messages);
    const rows = synthesizeAgentJobThreadMessages(all, all.filter((message) => shouldDisplayChatMessage(message)));
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext({ isViewer: true, name: null })}>
          <ConversationMessageRows
            identityLayout="participants"
            messages={rows}
            currentUserId="user-1"
            chatClientSessionId="session-1"
            projectId="project-1"
            runtimeId={null}
            conversationLocalId="conversation-local"
            conversationControllerId="conversation-controller"
            firstPlanMessageId={null}
            humanLabelByUserId={new Map()}
            runAgentIdentityByRunId={new Map()}
            runAgentHandleByRunId={new Map()}
            renderAssistantAvatar={(_metadata, identity) => {
              faces.push(identity ?? null);
              return <span data-testid="assistant-avatar" />;
            }}
            assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
            onRequestActions={vi.fn()}
            onRequestActionsAtPoint={vi.fn()}
            onCancelTerminalCommand={null}
            onMessageContextMenu={vi.fn()}
          />
        </RunFailureRetryProvider>,
      );
    });
    return rows;
  }

  function speakerNames(): Array<string | null> {
    return [...container.querySelectorAll('[data-testid="chat-speaker-name"]')].map((node) => node.textContent);
  }

  it("names and draws its failure as that agent's", async () => {
    await renderChat([prompt, failure]);

    expect(speakerNames()).toEqual(["cctrial"]);
    expect(faces.map((face) => face?.id)).toEqual([CCTRIAL.id]);
    expect(container.textContent).toContain(
      "Instafy couldn't check this space's folder on this computer, so Claude Code didn't start.",
    );
  });

  it("names its failure as that agent's while Try again's resend waits", async () => {
    const rows = await renderChat([prompt, failure, resend]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${FAILED_JOB}`]);
    expect(container.textContent).toContain("Trying again…");
    expect(speakerNames()).toEqual(["cctrial"]);
    expect(faces.map((face) => face?.id)).toEqual([CCTRIAL.id]);
  });

  it("names and draws the reply of its second try as that agent's", async () => {
    const rows = await renderChat([prompt, failure, resend, retryReply]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${RETRY_JOB}`]);
    expect(container.textContent).toContain("Took two tries");
    expect(container.textContent).toContain("I'm Claude, working in the folder of this space.");
    expect(speakerNames()).toEqual(["cctrial"]);
    expect(faces.map((face) => face?.id)).toEqual([CCTRIAL.id]);
    expect(
      [...container.querySelectorAll('[data-testid="turn-engine-speaker-line"]')].map((node) => node.textContent),
    ).toEqual(["Ran on your own Claude Code, on your computer"]);
  });
});
