// @vitest-environment jsdom
// A web search in the room: its row says "Searching the web" while it runs and "Searched the web" once done (the
// runtime's label for `instafy web search`), and what it keeps behind the row is only the query and the number of
// results (codex.rs `web_search_activity_output`), never a result's link, title or snippet.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { TimelineEntry } from "../ChatTimelineEntry";

vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus() {} }) }));

const COMMAND = "/bin/bash -lc 'instafy web search \"ramen shinjuku\" --count 8 --json'";
/** What runtime-agent keeps of the command's output. */
const KEPT = 'web search "ramen shinjuku" · 8 results\n(search results are not kept)';
/** The runtime's built-in label for `instafy web search` (jobs/activity_labels.rs). */
const ACTIVITY = {
  v: 1,
  key: "instafy/web-search",
  role: "content",
  live: "Searching the web",
  done: { one: "searched the web", other: "searched the web {n} times", some: "searched the web" },
  count: 1,
  also: [],
};

function searchRow(status: "in_progress" | "completed", aggregatedOutput: string): ChatMessage {
  return {
    id: `search-${status}`,
    role: "assistant",
    authorId: null,
    content: COMMAND,
    timestamp: 0,
    files: null,
    messageType: "command_execution",
    metadata: {
      source: "agent",
      jobId: "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      messageType: "command_execution",
      details: {
        kind: "codex_command_execution",
        itemId: "search-1",
        command: COMMAND,
        status,
        exitCode: status === "completed" ? 0 : null,
        aggregatedOutput,
      },
      activity: ACTIVITY,
    },
  };
}

describe("a web search in the room", () => {
  let root: Root;
  let container: HTMLDivElement;

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

  const render = (message: ChatMessage) =>
    act(async () =>
      root.render(
        <TimelineEntry
          message={message}
          conversationMessages={[message]}
          details={(message.metadata?.details as Record<string, unknown>) ?? null}
          metadataRecord={message.metadata ?? null}
          MessageContent={({ content }: { content: string }) => <span>{content}</span>}
          ChatFileChangeList={() => null}
          renderContext="conversation"
        />,
      ),
    );

  it("says it is searching the web while it runs, not the command", async () => {
    await render(searchRow("in_progress", ""));
    expect(container.querySelector('[data-testid="turn-activity-step-label"]')?.textContent).toBe("Searching the web");
    expect(container.textContent).not.toContain("--count");
  });

  it("says it searched the web once done, and keeps only the query and the count behind the row", async () => {
    await render(searchRow("completed", KEPT));
    expect(container.querySelector('[data-testid="turn-activity-step-label"]')?.textContent).toBe("Searched the web");
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="turn-activity-command-output-toggle"]');
    await act(async () => {
      toggle?.click();
    });
    const output = container.querySelector('[data-testid="chat-command-output"]')?.textContent ?? "";
    expect(output).toContain('web search "ramen shinjuku" · 8 results');
    expect(output).toContain("(search results are not kept)");
    expect(container.textContent).not.toMatch(/untrusted_page_content|https?:\/\//);
  });
});
