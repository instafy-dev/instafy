// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerRuntimeClaudeCode,
  ControllerRuntimeStatusEntry,
} from "../../../services/runtimeController/runtimes";
import { ClaudeCodeWaitingNote } from "../ClaudeCodeWaitingNote";
import { forgetClaudeCodeDesktopRefusalForTests } from "../claudeCodeDesktop";
import { bannedWordIn } from "./claudeCodeBannedWords";

// docs/Local-Engine-Turns.md 11.14: what a waiting Claude Code turn's row adds
// for its person, which is what makes the turn run.

const CONTROLLER_URL = "https://controller.example.test";
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_PROJECT_ID = "22222222-2222-4333-8444-555555555555";
const RUNTIME_ID = "99999999-8888-4777-8666-555555555555";

type DesktopStatus = { supported: boolean; found: boolean; consented: boolean; path?: string };

let desktopStatus: DesktopStatus;
let desktopRuntime: { running: boolean; projectId?: string; runtimeId?: string };

function entry(claudeCode: Partial<ControllerRuntimeClaudeCode> | null): ControllerRuntimeStatusEntry {
  return {
    runtimeId: RUNTIME_ID,
    status: "online",
    claudeCode: claudeCode
      ? { ready: true, reason: null, cli: "2.1.325", verified: true, planSignIn: true, resetsAt: null, ...claudeCode }
      : null,
  } as ControllerRuntimeStatusEntry;
}

describe("the note under a waiting Claude Code turn", () => {
  let container: HTMLDivElement;
  let root: Root;
  let startOnThisComputer: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetClaudeCodeDesktopRefusalForTests();
    desktopStatus = { supported: true, found: true, consented: true, path: "/opt/homebrew/bin/claude" };
    desktopRuntime = { running: false };
    startOnThisComputer = vi.fn<() => void>();
    Object.assign(window, {
      instafyDesktop: {
        invokeDesktopExtension: vi.fn(async () => desktopStatus),
        desktopRuntimeStatus: async () => desktopRuntime,
      },
    });
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

  async function render({
    runtimes = [],
    start = startOnThisComputer,
    starting = false,
  }: {
    runtimes?: ControllerRuntimeStatusEntry[];
    start?: (() => void) | null;
    starting?: boolean;
  } = {}) {
    await act(async () => {
      root.render(
        <ClaudeCodeWaitingNote
          projectId={PROJECT_ID}
          runtimes={runtimes}
          startOnThisComputer={start}
          starting={starting}
          resolveControllerUrl={async () => CONTROLLER_URL}
        />,
      );
    });
  }

  const note = () => container.querySelector('[data-testid="claude-code-waiting-note"]')?.textContent ?? null;
  const startButton = () => container.querySelector<HTMLButtonElement>('[data-testid="claude-code-waiting-start"]');

  it("in Desktop, where Claude Code is set up and this space isn't running here, offers to start it", async () => {
    await render();
    expect(note()).toContain("Start this space on this computer to run it.");
    expect(startButton()?.textContent).toBe("Start");
    await act(async () => startButton()?.click());
    expect(startOnThisComputer).toHaveBeenCalledTimes(1);
  });

  it("offers Start also when Desktop runs another space, which Desktop asks about before it replaces it", async () => {
    desktopRuntime = { running: true, projectId: OTHER_PROJECT_ID, runtimeId: "other-runtime" };
    await render();
    expect(note()).toContain("Start this space on this computer to run it.");
    expect(startButton()).not.toBeNull();
  });

  it("shows a start under way", async () => {
    await render({ starting: true });
    expect(startButton()?.textContent).toBe("Starting…");
    expect(startButton()?.disabled).toBe(true);
  });

  it("says where to set Claude Code up when this computer hasn't been", async () => {
    desktopStatus = { supported: true, found: false, consented: false };
    await render();
    expect(note()).toBe("Set up Claude Code on this computer in Your AI to run it here.");
    expect(startButton()).toBeNull();
  });

  it("outside Desktop, or on a Desktop that can't run it, says what runs it", async () => {
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    await render({ start: null });
    expect(note()).toBe("It runs when Instafy Desktop runs this space on your computer.");

    Object.assign(window, {
      instafyDesktop: {
        invokeDesktopExtension: vi.fn(async () => ({ supported: false, found: false, consented: false })),
        desktopRuntimeStatus: async () => desktopRuntime,
      },
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(note()).toBe("It runs when Instafy Desktop runs this space on your computer.");
  });

  it("says nothing more while this computer runs the space and its Claude Code is ready, or still reporting", async () => {
    desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: RUNTIME_ID };
    await render({ runtimes: [entry({})] });
    expect(container.innerHTML).toBe("");
    await render({ runtimes: [] });
    expect(container.innerHTML).toBe("");
  });

  it("says what keeps this computer's Claude Code from taking it", async () => {
    desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: RUNTIME_ID };
    await render({ runtimes: [entry({ ready: false, reason: "binary_missing" })] });
    expect(note()).toBe("Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI.");
  });

  it("leaves a plan's limit to the line, which says when it resets", async () => {
    const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await render({ runtimes: [entry({ ready: false, reason: null, resetsAt })] });
    expect(container.innerHTML).toBe("");
  });

  it("never uses a word the banned-word fixture lists", async () => {
    for (const status of [
      { supported: true, found: true, consented: true },
      { supported: true, found: false, consented: false },
      { supported: false, found: false, consented: false },
    ]) {
      desktopStatus = status;
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(bannedWordIn(container.textContent ?? ""), container.textContent ?? "").toBeNull();
    }
  });
});
