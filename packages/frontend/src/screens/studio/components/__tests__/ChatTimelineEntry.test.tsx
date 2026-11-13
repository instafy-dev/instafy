// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { TimelineEntry } from "../ChatTimelineEntry";

vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus() {} }) }));

const JOB_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const SPACE_ID = "d6aaf12d-3d56-45da-90d3-4806e2e47c10";

function MessageContent({ content }: { content: string }) {
  return <div data-testid="message-content">{content}</div>;
}

function commandMessage(command: string, output: string, activity: Record<string, unknown> | null): ChatMessage {
  return {
    id: `command-${command.length}`,
    role: "assistant",
    authorId: null,
    content: command,
    timestamp: 0,
    files: null,
    messageType: "command_execution",
    metadata: {
      source: "agent",
      jobId: JOB_ID,
      messageType: "command_execution",
      details: {
        kind: "codex_command_execution",
        itemId: "item-1",
        command,
        status: "completed",
        exitCode: 0,
        aggregatedOutput: output,
      },
      ...(activity ? { activity } : {}),
    },
  };
}

describe("a standalone command in the conversation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(message: ChatMessage, renderContext: "conversation" | "runTrace" = "conversation") {
    await act(async () => {
      root.render(
        <TimelineEntry
          message={message}
          conversationMessages={[message]}
          details={(message.metadata?.details as Record<string, unknown>) ?? null}
          metadataRecord={message.metadata ?? null}
          MessageContent={MessageContent}
          ChatFileChangeList={() => null}
          renderContext={renderContext}
        />,
      );
    });
  }

  it("renders as its label row with the command and output collapsed", async () => {
    const command = `bash -lc 'instafy web read https://www.visitlisboa.com/ https://en.wikipedia.org/wiki/Lisbon'`;
    await render(
      commandMessage(command, "Serving map at http://172.19.0.3:4173/", {
        v: 1,
        key: "instafy/web-read",
        role: "content",
        live: "Reading pages",
        done: { one: "read a page", other: "read {n} pages", some: "read pages" },
        count: 2,
        also: [],
      }),
    );

    expect(container.querySelector('[data-testid="turn-activity-step-label"]')?.textContent).toBe("Read 2 pages");
    expect(container.querySelector('[aria-label="Done"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-command-output"]')).toBeNull();
    expect(container.textContent).not.toContain("instafy web read");
    expect(container.textContent).not.toContain("172.19.0.3");

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="turn-activity-command-output-toggle"]');
    expect(toggle?.getAttribute("aria-label")).toBe("Show command");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      toggle?.click();
    });
    expect(container.querySelector('[data-testid="turn-activity-command-text"]')?.textContent).toBe(
      "instafy web read https://www.visitlisboa.com/ https://en.wikipedia.org/wiki/Lisbon",
    );
    expect(container.querySelector('[data-testid="chat-command-output"]')?.textContent).toContain("172.19.0.3");
  });

  it("never shows an unlabelled command line, which can carry the space id", async () => {
    await render(commandMessage(`instafy secrets list --space ${SPACE_ID} --json`, "[]", null));

    expect(container.querySelector('[data-testid="turn-activity-step-label"]')?.textContent).toBe("Ran a command");
    expect(container.textContent).not.toContain(SPACE_ID);
    expect(container.textContent).not.toContain("--json");
    expect(container.querySelector('[data-testid="chat-command-output"]')).toBeNull();
  });

  it("keeps the run trace's builder view", async () => {
    await render(commandMessage("bash -lc 'ls'", "README.md", null), "runTrace");

    expect(container.querySelector('[data-testid="turn-activity-command"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-command-output"]')?.textContent).toContain("bash -lc 'ls'");
  });
});

// docs/Local-Engine-Turns.md 5.7: a Claude Code turn's usage row shows the
// model it ran and the token counts, never a cost.
describe("a turn's usage row in the run trace", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function usageRow(details: Record<string, unknown>): ChatMessage {
    return {
      id: "usage-1",
      role: "assistant",
      authorId: null,
      content: "Claude Code reported: input 1000, cached 850, output 40",
      timestamp: 0,
      files: null,
      messageType: "token_usage",
      metadata: { source: "agent", jobId: JOB_ID, messageType: "token_usage", details },
    };
  }

  async function render(message: ChatMessage) {
    await act(async () => {
      root.render(
        <TimelineEntry
          message={message}
          conversationMessages={[message]}
          details={(message.metadata?.details as Record<string, unknown>) ?? null}
          metadataRecord={message.metadata ?? null}
          MessageContent={MessageContent}
          ChatFileChangeList={() => null}
          renderContext="runTrace"
        />,
      );
    });
  }

  it("names the model and counts the cache as the row's words do", async () => {
    await render(
      usageRow({
        kind: "claude_code_turn_usage",
        billed: false,
        usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 850, output_tokens: 40 },
        model: "claude-test-model",
      }),
    );
    expect(container.querySelector('[data-testid="timeline-usage-model"]')?.textContent).toBe("Model claude-test-model");
    expect(container.textContent).toContain("Input 1000");
    expect(container.textContent).toContain("Cached 850");
    expect(container.textContent).toContain("Output 40");
    expect(container.textContent).not.toMatch(/cost|\$/i);
  });

  it("shows no model for a usage row that names none", async () => {
    await render(
      usageRow({ kind: "codex_turn_usage", usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 75 } }),
    );
    expect(container.querySelector('[data-testid="timeline-usage-model"]')).toBeNull();
    expect(container.textContent).toContain("Input 1200");
  });
});
