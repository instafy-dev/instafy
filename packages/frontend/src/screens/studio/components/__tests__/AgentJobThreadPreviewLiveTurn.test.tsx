// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout } from "../AgentJobThreadPreviewLayout";
import { useAgentJobThreadPreviewState } from "../useAgentJobThreadPreviewState";

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

  it("keeps the rail and its status line still while a command starts and finishes", async () => {
    // Between commands nothing in the thread is running, so the run reads as
    // waiting (spinner pill); a command in flight reads as running. The rail
    // used to gain and lose the spine's end cap with each switch.
    const betweenCommands = earlierSteps();
    const commandRunning = [
      ...earlierSteps(),
      agentUpdate("command-2", "command_execution", "rg schema", base + 3_000, {
        status: "in_progress",
        command: "rg schema",
      }),
    ];

    await renderTurn(betweenCommands);
    const waitingShape = turnStructure(container);
    expect(container.querySelector('[aria-label="Run in progress"]')).toBeInstanceOf(HTMLElement);

    await renderTurn(commandRunning);
    const runningShape = turnStructure(container);
    expect(container.querySelector('[aria-label="Run in progress"]')).toBeNull();

    await renderTurn(betweenCommands);
    expect(runningShape).toEqual(waitingShape);
    expect(turnStructure(container)).toEqual(waitingShape);

    for (const shape of [waitingShape, runningShape]) {
      expect(shape.some((row) => row.includes("[agent-thread-spine-end]"))).toBe(false);
    }
    // One status line, in a fixed one-line box, and nothing running under it.
    const statusLines = container.querySelectorAll('[data-testid="agent-thread-compact-rail-status"]');
    expect(statusLines).toHaveLength(1);
    expect(statusLines[0]?.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-4", "leading-4"]));
    expect(statusLines[0]?.querySelector(".truncate")).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[data-testid="agent-thread-running-status"]')).toBeNull();
  });

  it("gives the live pill the same wrapper and box as a settled one", async () => {
    await renderTurn(earlierSteps());

    const pills = Array.from(container.querySelectorAll(".instafy-compact-event-pill"));
    expect(pills.length).toBe(4);
    const livePills = pills.filter((pill) => pill.classList.contains("instafy-compact-event-pill-live"));
    expect(livePills).toHaveLength(1);
    for (const pill of pills) {
      expect(pill.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-6", "w-6"]));
      expect(pill.parentElement?.className).toBe("relative inline-flex");
    }
    // Adding pills grows the rail sideways; it never wraps onto a second row.
    const pillRow = pills[0]?.parentElement?.parentElement;
    expect(pillRow?.className.split(/\s+/)).not.toContain("flex-wrap");
  });

  it("gives up the status line once, at completion, together with the reply", async () => {
    const running = earlierSteps();
    await renderTurn(running);
    expect(container.querySelector('[data-testid="agent-thread-compact-rail-status"]')).toBeInstanceOf(
      HTMLElement,
    );

    live.inFlight = false;
    await renderTurn([...running, reply("reply", "Here is what I found.", base + 4_000)]);

    expect(container.querySelector('[data-testid="agent-thread-compact-rail-status"]')).toBeNull();
    expect(container.querySelector(".instafy-status-sweep")).toBeNull();
    expect(container.querySelector('[data-testid="agent-thread-running-status"]')).toBeNull();
    expect(container.textContent).not.toContain("Analyzing output schema");
    expect(container.querySelector('[data-testid="message-content"]')?.textContent).toBe(
      "Here is what I found.",
    );
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

  it("keeps every card of the turn mounted when its reply lands after commentary", async () => {
    // Commentary statuses render as rail chips, not rows, yet they took places
    // in the inline window. Two cards and three statuses showed both cards
    // while the turn ran; the reply shrank the window from five to three and
    // unmounted both, with whatever the person was typing into them.
    const statuses = ["Checking the token scope", "Reading the service docs", "Comparing the account ids"].map(
      (text, index) => agentUpdate(`status-${index + 1}`, "status", text, base + 3_600 + index * 100),
    );
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
    // The statuses stay on the rail.
    expect(container.textContent).not.toContain("Checking the token scope");

    live.inFlight = false;
    await renderTurn([...running, reply("reply", "Two values are needed to finish setup.", base + 4_000)]);
    const settled = cards();
    expect(settled.map((card) => card.textContent)).toEqual(["secret-1", "secret-2"]);
    // The same elements: neither card was unmounted and mounted again.
    expect(settled[0]).toBe(whileRunning[0]);
    expect(settled[1]).toBe(whileRunning[1]);
  });

  it("never windows a card away when the reply shrinks a wide row's update window", async () => {
    // A wide row with four updates lists them all while the turn runs; the
    // reply keeps the newest three, which hid the card behind "1 earlier
    // update" and unmounted it.
    clientWidth.mockReturnValue(900);
    const card = agentUpdate("secret-1", "secret_request", "Add the API token.", base + 3_000, {
      name: "SERVICE_API_TOKEN",
    });
    const statuses = ["Checking the token scope", "Reading the service docs", "Comparing the account ids"].map(
      (text, index) => agentUpdate(`status-${index + 1}`, "status", text, base + 3_100 + index * 100),
    );
    const running = [card, ...statuses];

    await renderTurn(running);
    const whileRunning = container.querySelector('[data-testid="secret-request-card"]');
    expect(whileRunning).toBeInstanceOf(HTMLElement);

    live.inFlight = false;
    await renderTurn([...running, reply("reply", "One value is needed to finish setup.", base + 4_000)]);
    expect(container.querySelector('[data-testid="secret-request-card"]')).toBe(whileRunning);
    expect(container.textContent).not.toContain("earlier update");
  });

  it("counts only the updates that render as rows toward the compacted row's window", async () => {
    // An approval notice stays a row; the statuses after it are rail chips.
    // Counted with the chips it fell out of the window when the reply shrank
    // it, and the turn lost a row as it settled.
    const notice = agentUpdate("status-approval", "status", "Approval required to rotate the key", base + 3_000);
    const statuses = ["Checking the token scope", "Reading the service docs", "Comparing the account ids"].map(
      (text, index) => agentUpdate(`status-${index + 1}`, "status", text, base + 3_100 + index * 100),
    );
    const running = [...earlierSteps(), notice, ...statuses];

    await renderTurn(running);
    expect(container.textContent).toContain("Approval required to rotate the key");

    live.inFlight = false;
    await renderTurn([...running, reply("reply", "The key needs your approval first.", base + 4_000)]);
    expect(container.textContent).toContain("Approval required to rotate the key");
    expect(container.textContent).not.toContain("Comparing the account ids");
  });

  it("keeps a wide turn's command rows and running line still between commands", async () => {
    // A wide row with few updates has no rail. Between two commands isRunning
    // drops, and the rows used to follow it: the running command row gave way
    // to a collapsed output toggle plus a summary running line (about 24px),
    // which went away again when the next command started.
    clientWidth.mockReturnValue(900);
    const runningLine = () => container.querySelector('[data-testid="agent-thread-running-status"]');
    const outputToggle = () => container.querySelector('[data-testid="agent-thread-command-output-toggle"]');

    await renderTurn(earlierSteps());
    expect(runningLine()).toBeNull();
    expect(outputToggle()).toBeNull();
    const betweenCommands = turnStructure(container);

    await renderTurn([
      ...earlierSteps(),
      agentUpdate("command-2", "command_execution", "rg schema", base + 3_000, {
        status: "in_progress",
        command: "rg schema",
      }),
    ]);
    expect(runningLine()).toBeNull();
    expect(outputToggle()).toBeNull();
    expect(turnStructure(container)).toEqual(betweenCommands);

    await renderTurn([
      ...earlierSteps(),
      agentUpdate("command-2", "command_execution", "rg schema", base + 3_000, {
        status: "completed",
        command: "rg schema",
        aggregated_output: "schema.json",
      }),
    ]);
    expect(runningLine()).toBeNull();
    expect(outputToggle()).toBeNull();
    expect(turnStructure(container)).toEqual(betweenCommands);
  });

  it("keeps a wide turn that compacted into a rail compacted when its reply lands", async () => {
    // Five updates compact a wide row into a rail. The reply shrinks the
    // window to three, which used to turn the rail back into rows of status
    // text under an "earlier updates" control the moment the turn settled.
    clientWidth.mockReturnValue(900);
    const statuses = [
      "Checking the token scope",
      "Reading the service docs",
      "Comparing the account ids",
      "Listing the webhooks",
      "Drafting the setup steps",
    ].map((text, index) => agentUpdate(`status-${index + 1}`, "status", text, base + 3_000 + index * 100));

    await renderTurn(statuses);
    expect(container.querySelector('[data-testid="agent-thread-compact-rail"]')).toBeInstanceOf(HTMLElement);
    expect(container.textContent).not.toContain("Checking the token scope");

    live.inFlight = false;
    await renderTurn([...statuses, reply("reply", "Setup is ready.", base + 4_000)]);
    expect(container.textContent).not.toContain("earlier update");
    for (const text of ["Comparing the account ids", "Listing the webhooks", "Drafting the setup steps"]) {
      expect(container.textContent).not.toContain(text);
    }
    expect(container.querySelector('[data-testid="message-content"]')?.textContent).toBe("Setup is ready.");
  });

  it("keeps a long reasoning title on one truncated line when it is the running status", async () => {
    // Wide rows have no rail caption; the running line under the header
    // carries the title instead and must not wrap onto more lines.
    clientWidth.mockReturnValue(900);
    const title =
      "Comparing the output schema of the export endpoint with the fields the importer expects";
    await renderTurn([agentUpdate("reasoning-long", "reasoning", `**${title}**\n\nDetails.`, Date.now())]);

    const line = container.querySelector('[data-testid="agent-thread-running-status"]');
    expect(line).toBeInstanceOf(HTMLElement);
    expect(line?.className.split(/\s+/)).toContain("h-5");
    const text = line?.querySelector('[aria-live="polite"]');
    expect(text?.textContent).toBe(title);
    expect(text?.getAttribute("title")).toBe(title);
    expect(text?.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "max-w-full", "leading-5"]));
  });
});
