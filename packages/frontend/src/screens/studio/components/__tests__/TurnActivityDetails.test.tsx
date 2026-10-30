// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { TURN_ACTIVITY_DETAILS_ROW_CAP, TurnActivityDetails } from "../TurnActivityDetails";
import { turnStepFromMessage, type DetailItem } from "../turnActivity";

function commandItem(index: number): DetailItem {
  const message: ChatMessage = {
    id: `command-${index}`,
    role: "assistant",
    authorId: null,
    content: `uw add-point ${index}`,
    timestamp: index,
    files: null,
    messageType: "command_execution",
    metadata: {
      source: "agent",
      messageType: "command_execution",
      details: { kind: "codex_command_execution", itemId: `item-${index}`, command: `uw add-point ${index}`, status: "completed" },
    },
  };
  return {
    kind: "step",
    id: `command:item-${index}`,
    step: { kind: "command", message, activity: null, state: "done", label: `Step ${index}` },
  };
}

function toolItem(index: number, server: string, tool: string, activity: Record<string, unknown> | null): DetailItem {
  const message: ChatMessage = {
    id: `tool-${index}`,
    role: "assistant",
    authorId: null,
    content: tool,
    timestamp: index,
    files: null,
    messageType: "mcp_tool_call",
    metadata: {
      source: "agent",
      jobId: "job-1",
      messageType: "mcp_tool_call",
      details: { itemId: `tool-item-${index}`, status: "completed", server, tool },
      ...(activity ? { activity: { v: 1, count: 1, also: [], ...activity } } : {}),
    },
  };
  const step = turnStepFromMessage(message, "job-1");
  if (!step) throw new Error("not a step");
  return { kind: "step", id: `tool:${index}`, step };
}

describe("TurnActivityDetails", () => {
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

  // "Show N earlier steps" goes away once pressed. Focus went with it, to the
  // page, so a keyboard or screen reader user was sent back to the top of the
  // conversation instead of the steps they asked for.
  it("lists the newest 60 rows and, on Show earlier steps, all of them with focus on the first", async () => {
    const items = Array.from({ length: TURN_ACTIVITY_DETAILS_ROW_CAP + 2 }, (_, index) => commandItem(index));
    await act(async () => {
      root.render(<TurnActivityDetails id="details" items={items} renderUpdate={() => null} />);
    });

    const labels = () =>
      [...container.querySelectorAll('[data-testid="turn-activity-step-label"]')].map((label) => label.textContent);
    expect(labels()).toHaveLength(TURN_ACTIVITY_DETAILS_ROW_CAP);
    expect(labels()[0]).toBe("Step 2");
    const earlier = container.querySelector<HTMLButtonElement>('[data-testid="turn-activity-details-earlier"]');
    expect(earlier?.textContent).toBe("Show 2 earlier steps");

    earlier?.focus();
    await act(async () => {
      earlier?.click();
    });

    expect(labels()).toHaveLength(TURN_ACTIVITY_DETAILS_ROW_CAP + 2);
    expect(container.querySelector('[data-testid="turn-activity-details-earlier"]')).toBeNull();
    const firstRow = container.querySelector('[role="listitem"]');
    expect(document.activeElement).not.toBe(document.body);
    expect(firstRow?.contains(document.activeElement) || document.activeElement === firstRow).toBe(true);
  });

  // A local test: Details read "Used the browser  instafy_shared_browser/list_tabs"
  // and "Tried using the browser  instafy_shared_browser/snapshot".
  // A local test: three "Finding places to stay" rows kept spinning after
  // their turn had ended.
  it("shows a step its turn ended before without a spinner, in the past tense", async () => {
    const message: ChatMessage = {
      id: "stay",
      role: "assistant",
      authorId: null,
      content: "uw stay --near stations:lisbon",
      timestamp: 1,
      files: null,
      messageType: "command_execution",
      metadata: {
        source: "agent",
        messageType: "command_execution",
        details: { kind: "codex_command_execution", itemId: "stay", command: "uw stay --near stations:lisbon", status: "in_progress" },
      },
    };
    const item = (state: "running" | "unfinished", label: string): DetailItem => ({
      kind: "step",
      id: "command:stay",
      step: { kind: "command", message, activity: null, state, label },
    });
    await act(async () => {
      root.render(<TurnActivityDetails id="details" items={[item("running", "Finding places to stay")]} renderUpdate={() => null} />);
    });
    expect(container.querySelector('[aria-label="Running"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <TurnActivityDetails id="details" items={[item("unfinished", "Didn't finish finding places to stay")]} renderUpdate={() => null} />,
      );
    });
    expect(container.querySelector('[aria-label="Running"]')).toBeNull();
    expect(container.querySelector('[aria-label="Done"]')).toBeNull();
    expect(container.querySelector('[data-testid="turn-activity-step-label"]')?.textContent).toBe(
      "Didn't finish finding places to stay",
    );
  });

  it("shows a browser step's site, or only its words, never the tool's name", async () => {
    const items = [
      toolItem(1, "instafy_shared_browser", "list_tabs", {
        key: "browser/use", role: "content", live: "Using the browser", done: "used the browser", step: "tabs",
      }),
      toolItem(2, "instafy_shared_browser", "list_tabs", {
        key: "browser/browse", role: "quiet", live: "Browsing {host}", done: "browsed {host}", host: "visitlisboa.com", step: "tabs",
      }),
      toolItem(3, "instafy_shared_browser", "snapshot", {
        key: "browser/use", role: "content", live: "Using the browser", done: "used the browser", step: "snapshot",
      }),
      toolItem(4, "instafy_shared_browser", "navigate", {
        key: "browser/open", role: "content", live: "Opening {host}",
        done: { one: "opened {host}", other: "opened {n} pages on {host}", some: "opened pages on {host}" },
        host: "visitlisboa.com", pageKey: "aaaaaaaaaaaaaaaa", step: "navigate", when: "success",
      }),
      // An older runtime's browser step, with no label at all.
      toolItem(5, "instafy_shared_browser", "snapshot", null),
      // Another tool keeps its name: it is the only thing the row can say.
      toolItem(6, "github", "create_issue", null),
    ];
    await act(async () => {
      root.render(<TurnActivityDetails id="details" items={items} renderUpdate={() => null} />);
    });

    const rows = [...container.querySelectorAll('[data-testid="turn-activity-tool"]')].map((row) => row.textContent);
    expect(rows).toEqual([
      "Looked at the tabs",
      "Looked at the tabs",
      "Used the browser",
      "Opened visitlisboa.com",
      "Used the browser",
      "Used a toolgithub/create_issue",
    ]);
    expect(container.textContent).not.toContain("instafy_shared_browser");
  });
});
