// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAgentAiNote } from "../ClaudeCodeAgentAiNote";
import { forgetClaudeCodeDesktopRefusalForTests } from "../claudeCodeDesktop";
import { bannedWordIn } from "./claudeCodeBannedWords";

// docs/Local-Engine-Turns.md 11.14: in Desktop, on a computer where Claude
// Code isn't set up, the agent editor says where to set it up.

const CONTROLLER_URL = "https://controller.example.test";

describe("the agent editor's note under Claude Code", () => {
  let container: HTMLDivElement;
  let root: Root;
  let invokeDesktopExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetClaudeCodeDesktopRefusalForTests();
    invokeDesktopExtension = vi.fn(async () => ({ supported: true, found: false, consented: false }));
    Object.assign(window, { instafyDesktop: { invokeDesktopExtension } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<ClaudeCodeAgentAiNote resolveControllerUrl={async () => CONTROLLER_URL} />);
    });
  }

  const note = () => container.querySelector('[data-testid="agent-profile-claude-code-set-up"]')?.textContent ?? null;

  it("points to Your AI's row where this computer hasn't set Claude Code up", async () => {
    await render();
    expect(note()).toBe(
      "Claude Code isn't set up on this computer yet. Set it up in Connections, under Claude Code on this computer.",
    );
    expect(bannedWordIn(note() ?? "")).toBeNull();
    // Desktop is asked about the controller Studio talks to.
    expect(invokeDesktopExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "claude-code", method: "status", controllerUrl: CONTROLLER_URL }),
    );
  });

  it("says nothing where it is set up, where Desktop can't run it, or outside Desktop", async () => {
    invokeDesktopExtension.mockResolvedValue({ supported: true, found: true, consented: true });
    await render();
    expect(container.innerHTML).toBe("");

    invokeDesktopExtension.mockResolvedValue({ supported: false, found: false, consented: false });
    await render();
    expect(container.innerHTML).toBe("");

    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    await render();
    expect(container.innerHTML).toBe("");
  });
});
