// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { TURN_ACTIVITY_DETAILS_ROW_CAP, TurnActivityDetails } from "../TurnActivityDetails";
import type { DetailItem } from "../turnActivity";

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
});
