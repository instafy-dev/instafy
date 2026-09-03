import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  resolveThreadCompactEventPreview,
  THREAD_COMPACT_EVENT_PREVIEW_MAX_CHARS,
} from "../threadPreviewHelpers";

function createUpdate(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "update-1",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    ...overrides,
  };
}

describe("resolveThreadCompactEventPreview", () => {
  it("derives the unwrapped command line for command steps, monospace", () => {
    const update = createUpdate({
      content: "Command completed",
      metadata: {
        messageType: "command_execution",
        details: { command: "bash -lc 'pnpm --filter @instafy/frontend test:unit'" },
      },
    });
    expect(resolveThreadCompactEventPreview(update, "command")).toEqual({
      text: "pnpm --filter @instafy/frontend test:unit",
      mono: true,
    });
  });

  it("prefers the search query over the message summary for search steps", () => {
    const update = createUpdate({
      content: 'Web search completed: "react aria hover cards"',
      metadata: {
        messageType: "web_search",
        details: { kind: "codex_web_search", query: "react aria hover cards" },
      },
    });
    expect(resolveThreadCompactEventPreview(update, "search")).toEqual({
      text: "react aria hover cards",
      mono: false,
    });
  });

  it("falls back to the message content when a search step has no query detail", () => {
    const update = createUpdate({ content: "Web search completed" });
    expect(resolveThreadCompactEventPreview(update, "search")).toEqual({
      text: "Web search completed",
      mono: false,
    });
  });

  it("describes tool steps as server/tool with a one-line argument summary", () => {
    const update = createUpdate({
      content: "Tool call completed: templates/template.search",
      metadata: {
        messageType: "mcp_tool_call",
        details: {
          server: "templates",
          tool: "template.search",
          arguments: { query: "landing page" },
        },
      },
    });
    expect(resolveThreadCompactEventPreview(update, "tool")).toEqual({
      text: 'templates/template.search {"query":"landing page"}',
      mono: true,
    });
  });

  it("keeps up to three lines for thinking steps and drops the rest", () => {
    const update = createUpdate({
      content: "First insight\nSecond insight\n\nThird insight\nFourth insight",
    });
    expect(resolveThreadCompactEventPreview(update, "thinking")).toEqual({
      text: "First insight\nSecond insight\nThird insight",
      mono: false,
    });
  });

  it("lists the first plan items with completion markers", () => {
    const update = createUpdate({
      content: "Plan updated",
      metadata: {
        messageType: "todo_list",
        details: {
          items: [
            { text: "Audit the rail", completed: true },
            { text: "Add the hover card", completed: false },
            { text: "Write tests", completed: false },
            { text: "Ship it", completed: false },
          ],
        },
      },
    });
    expect(resolveThreadCompactEventPreview(update, "plan")).toEqual({
      text: "✓ Audit the rail\n· Add the hover card\n· Write tests",
      mono: false,
    });
  });

  it("uses the status text for runtime steps, whitespace-collapsed", () => {
    const update = createUpdate({ content: "Switching   to\nthe shared runtime" });
    expect(resolveThreadCompactEventPreview(update, "runtime")).toEqual({
      text: "Switching to the shared runtime",
      mono: false,
    });
  });

  it("truncates hard at the preview cap", () => {
    const update = createUpdate({ content: "npm run something -- ".repeat(40) });
    const preview = resolveThreadCompactEventPreview(update, "runtime");
    expect(preview).not.toBeNull();
    expect(preview?.text.length).toBeLessThanOrEqual(THREAD_COMPACT_EVENT_PREVIEW_MAX_CHARS + 1);
    expect(preview?.text.endsWith("…")).toBe(true);
  });

  it("returns null when the step carries nothing worth previewing", () => {
    const update = createUpdate({ content: "   " });
    expect(resolveThreadCompactEventPreview(update, "thinking")).toBeNull();
    expect(resolveThreadCompactEventPreview(update, "command")).toBeNull();
  });
});
