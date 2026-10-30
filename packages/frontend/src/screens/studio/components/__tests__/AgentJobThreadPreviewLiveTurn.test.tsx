// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout } from "../AgentJobThreadPreviewLayout";
import { useAgentJobThreadPreviewState } from "../useAgentJobThreadPreviewState";
import { ACTIVITY_LABEL_HOLD_MS } from "../useSteadyActivityLabel";

// One live turn at phone width, replayed message by message through the live
// hook, the way production showed it: the rail moved while commands started
// and finished, the turn's cards arrived after its reply, and a status line
// outlived the answer.

const JOB_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CONTROLLER_ID = "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5";

const live = vi.hoisted(() => ({ inFlight: false }));

function inProgressRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: JOB_ID,
    projectId: "project-1",
    sessionId: null,
    conversationId: CONTROLLER_ID,
    promptId: null,
    runType: "prompt",
    status: "in_progress",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: { jobId: JOB_ID },
    createdAt: now,
    updatedAt: now,
  };
}

vi.mock("../../../../conversations/ConversationsProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../conversations/ConversationsProvider")>()),
  useConversations: () => ({
    activeConversation: live.inFlight
      ? {
          localId: "conversation-local",
          controllerId: CONTROLLER_ID,
          pendingRunIds: [JOB_ID],
          awaitingLeaseRunIds: [],
          pendingRunSubmittedAt: {},
          messages: [],
        }
      : null,
    conversations: [],
  }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runs: live.inFlight ? { [JOB_ID]: inProgressRun() } : {} }),
}));

// The cards' own behaviour has its own tests; here only where and when they
// render matters.
vi.mock("../ChatCredentialRequestEntries", () => ({
  SecretRequestEntry: ({ message }: { message: ChatMessage }) => (
    <div data-testid="secret-request-card">{message.id}</div>
  ),
  IntegrationRequestEntry: ({ message }: { message: ChatMessage }) => (
    <div data-testid="integration-request-card">{message.id}</div>
  ),
}));

function MessageContent({ content }: { content: string }) {
  return <div data-testid="message-content">{content}</div>;
}

function LiveTurn({ threadMessages }: { threadMessages: ChatMessage[] }) {
  const message: ChatMessage = {
    id: `agent-job-thread:${JOB_ID}`,
    role: "assistant",
    content: "",
    timestamp: threadMessages[0]?.timestamp ?? 0,
    messageType: "agent_job_thread",
    metadata: { messageType: "agent_job_thread", jobId: JOB_ID, threadMessages },
  };
  const state = useAgentJobThreadPreviewState({ message, projectId: "project-1" });
  if (!state) {
    return null;
  }
  return (
    <AgentJobThreadPreviewLayout
      {...state}
      branchThreads={[]}
      onOpenBranchThread={() => {}}
      MessageContent={MessageContent}
      ChatFileChangeList={() => null}
    />
  );
}

function agentUpdate(
  id: string,
  messageType: string,
  content: string,
  timestamp: number,
  details: Record<string, unknown> = {},
): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content,
    timestamp,
    files: null,
    messageType,
    metadata: {
      source: "agent",
      outcome: "in_progress",
      kind: "update",
      jobId: JOB_ID,
      messageType,
      details,
    },
  };
}

function reply(id: string, content: string, timestamp: number): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content,
    timestamp,
    files: null,
    metadata: { source: "agent", outcome: "success", jobId: JOB_ID },
  };
}

// The thread preview's own rows, top to bottom, as class and test id only:
// equal signatures mean the turn kept its shape and height.
function turnStructure(container: HTMLElement): string[] {
  const preview = container.querySelector('[data-testid="agent-job-thread-preview"]');
  expect(preview).toBeInstanceOf(HTMLElement);
  return Array.from(preview!.children).map(
    (child) =>
      `${child.tagName}.${child.className}[${child.getAttribute("data-testid") ?? ""}]{${(child as HTMLElement).style.cssText}}`,
  );
}

describe("AgentJobThreadPreviewLayout live turn", () => {
  let container: HTMLDivElement;
  let root: Root;
  let base: number;
  let clientWidth: MockInstance<() => number>;

  async function renderTurn(threadMessages: ChatMessage[]) {
    await act(async () => {
      root.render(<LiveTurn threadMessages={threadMessages} />);
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    live.inFlight = true;
    base = Date.now() - 30_000;
    // A phone-width row: the compact rail with one caption line.
    clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clientWidth.mockRestore();
    live.inFlight = false;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function earlierSteps(): ChatMessage[] {
    return [
      agentUpdate("reasoning-1", "reasoning", "**Reading the request**\n\nDetails.", base, {
        status: "completed",
      }),
      agentUpdate("command-1", "command_execution", "ls", base + 1_000, {
        status: "completed",
        command: "ls",
        aggregated_output: "README.md",
      }),
      agentUpdate("reasoning-2", "reasoning", "**Analyzing output schema**\n\nDetails.", base + 2_000, {
        status: "completed",
      }),
    ];
  }

  const activityLine = () => container.querySelector<HTMLElement>('[data-testid="turn-activity-line"]');

  it.each([390, 900])(
    "keeps the turn still while a command starts and finishes (%ipx)",
    async (width) => {
      // Between commands nothing in the thread is running; a command in flight
      // is running. The turn used to swap rails, rows and output blocks at
      // each switch, and gain and lose the spine's end cap.
      clientWidth.mockReturnValue(width);
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const betweenCommands = earlierSteps();
      const commandRunning = [
        ...earlierSteps(),
        agentUpdate("command-2", "command_execution", "rg schema", base + 3_000, {
          status: "in_progress",
          command: "rg schema",
        }),
      ];
      const commandDone = [
        ...earlierSteps(),
        agentUpdate("command-2", "command_execution", "rg schema", base + 3_000, {
          status: "completed",
          command: "rg schema",
          aggregated_output: "schema.json",
        }),
      ];

      await renderTurn(betweenCommands);
      const waitingShape = turnStructure(container);
      expect(activityLine()?.textContent).toBe("Thinking…" + "Details");

      await renderTurn(commandRunning);
      expect(turnStructure(container)).toEqual(waitingShape);
      // The line holds its label a moment, so a quick step never flashes past.
      expect(activityLine()?.textContent).toBe("Thinking…" + "Details");
      await act(async () => {
        vi.advanceTimersByTime(ACTIVITY_LABEL_HOLD_MS);
      });
      expect(turnStructure(container)).toEqual(waitingShape);
      expect(activityLine()?.textContent).toBe("Working…" + "Details");

      await renderTurn(commandDone);
      expect(turnStructure(container)).toEqual(waitingShape);

      expect(waitingShape.some((row) => row.includes("[agent-thread-spine-end]"))).toBe(false);
      // One line, in a fixed one-line box, never the command or its output.
      const lines = container.querySelectorAll('[data-testid="turn-activity-line"]');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-5", "leading-5"]));
      expect(lines[0]?.querySelector(".truncate")).toBeInstanceOf(HTMLElement);
      expect(container.textContent).not.toContain("rg schema");
      expect(container.textContent).not.toContain("schema.json");
      expect(container.querySelector('[data-testid="chat-command-output"]')).toBeNull();
    },
  );

  it("gives up the live line once, at completion, together with the reply", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const running = earlierSteps();
    await renderTurn(running);
    expect(activityLine()?.querySelector(".instafy-status-sweep")).toBeInstanceOf(HTMLElement);

    live.inFlight = false;
    await renderTurn([...running, reply("reply", "Here is what I found.", base + 4_000)]);

    expect(container.querySelector(".instafy-status-sweep")).toBeNull();
    expect(container.querySelector('[data-testid="turn-activity-announcement"]')).toBeNull();
    // The last running label holds its moment before the done line takes its place.
    expect(activityLine()?.textContent).toBe("Thinking…" + "Details");
    await act(async () => {
      vi.advanceTimersByTime(ACTIVITY_LABEL_HOLD_MS);
    });
    expect(activityLine()?.textContent).toBe("Ran a command" + "Details");
    expect(container.textContent).not.toContain("Analyzing output schema");
    expect(container.querySelector('[data-testid="message-content"]')?.textContent).toBe(
      "Here is what I found.",
    );
  });

  // A local test: "Thinking…" was on screen 1.0 s when the failure block took
  // its place; every other label holds at least its moment.
  it("holds its last running label its moment before the failure block takes its place", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const running = earlierSteps();
    await renderTurn(running);
    expect(activityLine()?.textContent).toBe("Thinking…" + "Details");

    live.inFlight = false;
    const failure: ChatMessage = {
      id: "failure",
      role: "assistant",
      authorId: null,
      content: "Octo couldn't open a page in the browser, so this turn stopped.",
      timestamp: base + 4_000,
      files: null,
      messageType: "error",
      metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: JOB_ID },
    };
    await renderTurn([...running, failure]);
    expect(activityLine()?.textContent).toBe("Thinking…");
    expect(container.querySelector('[data-testid="run-failure-body"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(ACTIVITY_LABEL_HOLD_MS);
    });
    expect(activityLine()).toBeNull();
    expect(container.querySelector('[data-testid="run-failure-body"]')?.textContent).toContain(
      "Octo couldn't open a page in the browser, so this turn stopped.",
    );
  });

  it("settles with its reply while the run record still reads running", async () => {
    // A short reply landed while the run record still read running, and the
    // turn settled seconds later, with the run record. The reply alone settles
    // the turn: here the run is still in flight and the job's last progress is
    // stamped after the reply (a message's time is when the transaction that
    // wrote it began).
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const card = agentUpdate("secret-1", "secret_request", "Add the API token.", base + 3_000, {
      name: "SERVICE_API_TOKEN",
    });
    const running = [...earlierSteps(), card];

    await renderTurn(running);
    expect(activityLine()?.textContent).toBe("Thinking…" + "Details");
    await act(async () => {
      vi.advanceTimersByTime(ACTIVITY_LABEL_HOLD_MS);
    });
    const cardWhileRunning = container.querySelector('[data-testid="secret-request-card"]');
    expect(cardWhileRunning).toBeInstanceOf(HTMLElement);

    // The run record has not caught up: the run is still in flight.
    const answered = [
      ...running,
      reply("reply", "There are 12 files in this space.", base + 4_000),
      agentUpdate("status-late", "status", "Counting the entries", base + 4_005, { kind: "agent_message" }),
    ];
    await renderTurn(answered);

    expect(container.querySelector(".instafy-status-sweep")).toBeNull();
    expect(activityLine()?.textContent).toBe("Ran a command" + "Details");
    expect(container.querySelector('[data-testid="message-content"]')?.textContent).toBe(
      "There are 12 files in this space.",
    );
    // The card stays the same element through the settle.
    expect(container.querySelector('[data-testid="secret-request-card"]')).toBe(cardWhileRunning);
    const settledWithReply = turnStructure(container);

    // Nothing moves when the run record catches up.
    live.inFlight = false;
    await renderTurn(answered);
    expect(turnStructure(container)).toEqual(settledWithReply);
    expect(container.querySelector('[data-testid="secret-request-card"]')).toBe(cardWhileRunning);
  });

  it("renders the turn's cards the moment they arrive and keeps them with the reply", async () => {
    // The newest card of a running turn used to be taken for the reply: it
    // stayed hidden until the real reply came, then both popped in at once.
    const firstCard = agentUpdate("secret-1", "secret_request", "Add the API token.", base + 3_000, {
      name: "SERVICE_API_TOKEN",
    });
    const secondCard = agentUpdate("secret-2", "secret_request", "Add the account id.", base + 3_500, {
      name: "SERVICE_ACCOUNT_ID",
    });
    const cards = () =>
      Array.from(container.querySelectorAll('[data-testid="secret-request-card"]')).map(
        (card) => card.textContent,
      );

    await renderTurn([...earlierSteps(), firstCard]);
    expect(cards()).toEqual(["secret-1"]);
    // A card is never shown as the reply or a running preview of it.
    expect(container.querySelector('[data-testid="message-content"]')).toBeNull();

    await renderTurn([...earlierSteps(), firstCard, secondCard]);
    expect(cards()).toEqual(["secret-1", "secret-2"]);

    live.inFlight = false;
    await renderTurn([
      ...earlierSteps(),
      firstCard,
      secondCard,
      reply("reply", "Two values are needed to finish setup.", base + 4_000),
    ]);
    expect(cards()).toEqual(["secret-1", "secret-2"]);
    expect(
      Array.from(container.querySelectorAll('[data-testid="message-content"]')).map((node) => node.textContent),
    ).toEqual(["Two values are needed to finish setup."]);
  });

  it.each([390, 900])(
    "keeps every card mounted and Octo's notes in Details when the reply lands (%ipx)",
    async (width) => {
      // A reply used to shrink the turn's update window and unmount cards
      // with whatever the person was typing into them.
      clientWidth.mockReturnValue(width);
      const statuses = [
        "Checking the token scope",
        "Reading the service docs",
        "Comparing the account ids",
        "Approval required to rotate the key",
      ].map((text, index) => agentUpdate(`status-${index + 1}`, "status", text, base + 3_600 + index * 100));
      const running = [
        ...earlierSteps(),
        agentUpdate("secret-1", "secret_request", "Add the API token.", base + 3_000, { name: "SERVICE_API_TOKEN" }),
        agentUpdate("secret-2", "secret_request", "Add the account id.", base + 3_500, { name: "SERVICE_ACCOUNT_ID" }),
        ...statuses,
      ];
      const cards = () => Array.from(container.querySelectorAll('[data-testid="secret-request-card"]'));

      await renderTurn(running);
      const whileRunning = cards();
      expect(whileRunning.map((card) => card.textContent)).toEqual(["secret-1", "secret-2"]);
      for (const status of statuses) {
        expect(container.textContent).not.toContain(status.content);
      }

      live.inFlight = false;
      await renderTurn([...running, reply("reply", "Two values are needed to finish setup.", base + 4_000)]);
      const settled = cards();
      expect(settled.map((card) => card.textContent)).toEqual(["secret-1", "secret-2"]);
      // The same elements: neither card was unmounted and mounted again.
      expect(settled[0]).toBe(whileRunning[0]);
      expect(settled[1]).toBe(whileRunning[1]);
      expect(container.textContent).not.toContain("earlier update");

      // Octo's reasoning titles and notes are one press away, in order.
      await act(async () => {
        activityLine()?.click();
      });
      const rows = Array.from(container.querySelectorAll('[data-testid="agent-thread-inline-update-row"]')).map(
        (row) => row.textContent,
      );
      expect(rows).toEqual([
        expect.stringContaining("Reading the request"),
        expect.stringContaining("Analyzing output schema"),
        ...statuses.map((status) => status.content),
      ]);
    },
  );

  it("never turns a long reasoning title into the running line", async () => {
    const title =
      "Comparing the output schema of the export endpoint with the fields the importer expects";
    await renderTurn([
      ...earlierSteps(),
      agentUpdate("reasoning-long", "reasoning", `**${title}**\n\nDetails.`, Date.now(), { status: "in_progress" }),
    ]);

    expect(activityLine()?.textContent).toBe("Thinking…" + "Details");
    expect(container.textContent).not.toContain(title);
  });
});
