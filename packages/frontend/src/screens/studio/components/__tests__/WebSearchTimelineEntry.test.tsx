// @vitest-environment jsdom
// A web search in the room: while it runs, the entry says what it searches for; once done, it shows only what the
// runtime kept of it (the query and the number of results), never a result's link, title or snippet.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { TimelineEntry } from "../ChatTimelineEntry";

const COMMAND = "/bin/bash -lc 'instafy web search \"ramen shinjuku\" --count 8 --json'";
/** What runtime-agent keeps of the command's output (codex.rs `web_search_activity_output`). */
const KEPT = 'web search "ramen shinjuku" · 8 results\n(search results are not kept)';

function searchRow(status: "in_progress" | "completed", aggregatedOutput: string): ChatMessage {
  return {
    id: `search-${status}`,
    role: "assistant",
    authorId: null,
    content: COMMAND,
    timestamp: Date.now(),
    files: null,
    messageType: "command_execution",
    metadata: { kind: "codex_command_execution", messageType: "command_execution", status, command: COMMAND, aggregatedOutput },
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
          details={null}
          MessageContent={({ content }: { content: string }) => <span>{content}</span>}
          ChatFileChangeList={() => null}
        />,
      ),
    );

  it("says what it searches for while it runs, not the command", async () => {
    await render(searchRow("in_progress", ""));
    expect(container.textContent).toContain('Searching the web for "ramen shinjuku"…');
    expect(container.textContent).not.toContain("--count");
  });

  it("shows the query and the count once done, and no result", async () => {
    await render(searchRow("completed", KEPT));
    expect(container.textContent).toContain('web search "ramen shinjuku" · 8 results');
    expect(container.textContent).toContain("(search results are not kept)");
    expect(container.textContent).not.toMatch(/untrusted_page_content|https?:\/\/(?!instafy)/);
  });
});
