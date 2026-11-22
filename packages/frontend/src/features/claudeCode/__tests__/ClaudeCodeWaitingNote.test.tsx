// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerRuntimeClaudeCode,
  ControllerRuntimeClaudeCodeLogin,
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
// Two of the person's Claude Code logins (docs/Local-Engine-Turns.md 11.19).
const WORK = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
const PERSONAL = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";
const READY_LOGIN: ControllerRuntimeClaudeCodeLogin = { ready: true, reason: null, resetsAt: null, planSignIn: true, signedIn: true };
// The run's stamp, with the login its job runs on.
const RAN_ON_WORK = { aiAccessMode: "claude-code", claudeCode: { version: 1, loginId: WORK } };

type DesktopStatus = {
  supported: boolean;
  found: boolean;
  consented: boolean;
  path?: string;
  logins?: Array<{ id: string; folder: string | null }>;
};

let desktopStatus: DesktopStatus;
let desktopRuntime: { running: boolean; projectId?: string; runtimeId?: string };

function entry(claudeCode: Partial<ControllerRuntimeClaudeCode> | null): ControllerRuntimeStatusEntry {
  return {
    runtimeId: RUNTIME_ID,
    status: "online",
    claudeCode: claudeCode
      ? { ready: true, reason: null, cli: "2.1.325", verified: true, logins: { [WORK]: READY_LOGIN }, ...claudeCode }
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
    desktopStatus = {
      supported: true,
      found: true,
      consented: true,
      path: "/opt/homebrew/bin/claude",
      logins: [{ id: WORK, folder: null }],
    };
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
    runMetadata = RAN_ON_WORK,
  }: {
    runtimes?: ControllerRuntimeStatusEntry[];
    start?: (() => void) | null;
    starting?: boolean;
    runMetadata?: Record<string, unknown> | null;
  } = {}) {
    await act(async () => {
      root.render(
        <ClaudeCodeWaitingNote
          projectId={PROJECT_ID}
          runtimes={runtimes}
          startOnThisComputer={start}
          starting={starting}
          resolveControllerUrl={async () => CONTROLLER_URL}
          runMetadata={runMetadata}
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
    const held = { ...READY_LOGIN, ready: false, reason: "plan_limit" as const, resetsAt };
    await render({ runtimes: [entry({ logins: { [WORK]: held } })] });
    expect(container.innerHTML).toBe("");
    // As the line does, the note reads the turn's own login: another one held
    // isn't what this turn waits for.
    await render({ runtimes: [entry({ logins: { [WORK]: READY_LOGIN, [PERSONAL]: held } })] });
    expect(note()).toContain("Start this space on this computer to run it.");
  });

  // 11.19: a computer runs a turn only on a login set up there.
  it("says the turn's login isn't set up here, rather than offering a start that wouldn't run it", async () => {
    desktopStatus = { ...desktopStatus, logins: [{ id: PERSONAL, folder: "/home/sam/.claude-personal" }] };
    await render();
    expect(note()).toBe(
      "The Claude Code login this turn runs on isn't set up on this computer. Set it up in Your AI to run it here.",
    );
    expect(startButton()).toBeNull();
    // A stamp without a login says nothing of one.
    await render({ runMetadata: { aiAccessMode: "claude-code", claudeCode: { version: 1 } } });
    expect(note()).toContain("Start this space on this computer to run it.");
  });

  it("says what keeps the turn's login on this computer from taking it", async () => {
    desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: RUNTIME_ID };
    const unsafe = { ...READY_LOGIN, ready: false, reason: "binary_unsafe" as const };
    await render({ runtimes: [entry({ logins: { [WORK]: unsafe, [PERSONAL]: READY_LOGIN } })] });
    expect(note()).toContain("Instafy Desktop won't start this copy of Claude Code");
    // Another login's trouble is not this turn's.
    await render({ runtimes: [entry({ logins: { [WORK]: READY_LOGIN, [PERSONAL]: unsafe } })] });
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
