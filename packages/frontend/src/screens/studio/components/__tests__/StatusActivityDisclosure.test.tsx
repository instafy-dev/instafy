// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: vi.fn() }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openPanelTab: vi.fn(), requestUrlPush: vi.fn() }),
}));

import { StatusActivityEntry } from "../ChatActivityEntries";
import type { ChatMessage } from "../../types";

const NotchedMessageShell = ({ children }: { children?: unknown }) =>
  createElement("div", null, children as never);
const ChatFileChangeList = () => null;

function statusMessage(content: string): ChatMessage {
  return {
    id: `status-${content.length}`,
    role: "assistant",
    content,
    timestamp: 0,
    messageType: "status",
    metadata: { messageType: "status" },
  };
}

function renderEntry(root: Root, message: ChatMessage) {
  root.render(
    createElement(StatusActivityEntry, {
      message,
      projectId: "p1",
      // Injected shells the real chat wires in.
      NotchedMessageShell: NotchedMessageShell as never,
      ChatFileChangeList: ChatFileChangeList as never,
      chatLeftSpineOffsetClass: "left-0",
    }),
  );
}

// > 420 chars so hasLongContent is true and the disclosure toggle renders.
const LONG = `Posted the release notes to #announcements | ${"Notified reviewers and linked the deploy summary. ".repeat(8)}`;
const SHORT = "Refreshed the preview deployment.";

describe("StatusActivityEntry disclosure vocabulary", () => {
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

  it("long content uses the shared aria disclosure toggle that reveals the details region", async () => {
    expect(LONG.length).toBeGreaterThan(420);
    await act(async () => {
      renderEntry(root, statusMessage(LONG));
    });

    const toggle = container.querySelector<HTMLButtonElement>("button[aria-controls]");
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("Real-world action");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    // aria-controls must resolve to a real element — the disclosure contract.
    const controls = toggle?.getAttribute("aria-controls") ?? "";
    expect(controls).not.toBe("");
    expect(document.getElementById(controls)).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("short content is a static label with no disclosure control", async () => {
    await act(async () => {
      renderEntry(root, statusMessage(SHORT));
    });

    expect(container.textContent).toContain("Real-world action");
    expect(container.querySelector("button[aria-controls]")).toBeNull();
  });
});
