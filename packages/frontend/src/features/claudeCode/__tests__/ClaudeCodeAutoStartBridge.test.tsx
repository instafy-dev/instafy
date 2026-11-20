// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../types";

// docs/Local-Engine-Turns.md 11.14, D44: in Desktop, on a computer where
// Claude Code is set up, opening a space where a turn of the person's waits
// starts it on this computer, once, and only while Desktop runs nothing.

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_PROJECT_ID = "22222222-2222-4333-8444-555555555555";
const USER_ID = "aaaaaaaa-2222-4333-8444-555555555555";
const TEAMMATE_ID = "bbbbbbbb-2222-4333-8444-555555555555";

const mocks = vi.hoisted(() => ({
  projectId: "",
  user: { id: "" } as { id: string } | null,
  runs: {} as Record<string, unknown>,
  showStatus: vi.fn(),
  startSpaceOnThisComputer: vi.fn(),
  canStart: true,
}));

vi.mock("../../../feature-api/runtimeBridge", () => ({ useActiveProjectId: () => mocks.projectId }));
vi.mock("../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../../runtime/RuntimeStateProvider", () => ({ useOptionalRuntimeState: () => ({ runs: mocks.runs }) }));
vi.mock("../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../sdk/instafy", () => ({
  controllerClient: {
    core: { resolveRequestContext: async () => ({ baseUrl: "https://controller.example.test", accessToken: "inert" }) },
  },
}));
vi.mock("../../../runtime/desktopSpaceStart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/desktopSpaceStart")>()),
  canStartSpaceOnThisComputer: () => mocks.canStart,
  startSpaceOnThisComputer: mocks.startSpaceOnThisComputer,
}));

import { ClaudeCodeAutoStartBridge, isWaitingClaudeCodeTurnOf } from "../ClaudeCodeAutoStartBridge";
import { forgetClaudeCodeDesktopRefusalForTests } from "../claudeCodeDesktop";

const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 } };

function run(overrides: Partial<RunRecord> = {}, metadata: Record<string, unknown> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: PROJECT_ID,
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "queued",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: { ...STAMP, initiatingUserId: USER_ID, ...metadata },
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as RunRecord;
}

describe("Studio's start of a space where a Claude Code turn waits", () => {
  let container: HTMLDivElement;
  let root: Root;
  let desktopStatus: { supported: boolean; found: boolean; consented: boolean };
  let desktopRuntime: { running: boolean; projectId?: string } | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetClaudeCodeDesktopRefusalForTests();
    mocks.projectId = PROJECT_ID;
    mocks.user = { id: USER_ID };
    mocks.runs = { "run-1": run() };
    mocks.canStart = true;
    mocks.showStatus.mockReset();
    mocks.startSpaceOnThisComputer.mockReset();
    mocks.startSpaceOnThisComputer.mockResolvedValue({ kind: "started", status: { running: true } });
    desktopStatus = { supported: true, found: true, consented: true };
    desktopRuntime = { running: false };
    Object.assign(window, {
      instafyDesktop: {
        invokeDesktopExtension: vi.fn(async () => desktopStatus),
        desktopRuntimeStatus: vi.fn(async () => desktopRuntime),
        startDesktopRuntime: vi.fn(),
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

  async function render() {
    await act(async () => {
      root.render(<ClaudeCodeAutoStartBridge />);
    });
    // The checks Desktop answers, and the start.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("starts the open space on this computer once, as the Start action does, and says so", async () => {
    await render();
    expect(mocks.startSpaceOnThisComputer).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
    expect(mocks.showStatus).toHaveBeenCalledWith("Started this space on this computer.", "success", 3200);

    // The same visit never starts it again: not when the runs change, nor
    // after the person stopped it.
    mocks.runs = { "run-1": run(), "run-2": run({ id: "run-2" }) };
    desktopRuntime = { running: false };
    await render();
    expect(mocks.startSpaceOnThisComputer).toHaveBeenCalledTimes(1);
  });

  it("starts it again on the next visit to the space", async () => {
    await render();
    mocks.projectId = OTHER_PROJECT_ID;
    mocks.runs = {};
    await render();
    mocks.projectId = PROJECT_ID;
    mocks.runs = { "run-1": run() };
    await render();
    expect(mocks.startSpaceOnThisComputer).toHaveBeenCalledTimes(2);
  });

  it("never replaces a runtime Desktop runs, whatever its space, nor starts when Desktop can't say", async () => {
    desktopRuntime = { running: true, projectId: OTHER_PROJECT_ID };
    await render();
    desktopRuntime = null;
    mocks.projectId = OTHER_PROJECT_ID;
    mocks.runs = { "run-1": run({ projectId: OTHER_PROJECT_ID }) };
    await render();
    expect(mocks.startSpaceOnThisComputer).not.toHaveBeenCalled();
  });

  it("starts nothing where Claude Code isn't set up, or can't run", async () => {
    desktopStatus = { supported: true, found: true, consented: false };
    await render();
    desktopStatus = { supported: false, found: false, consented: false };
    mocks.projectId = OTHER_PROJECT_ID;
    mocks.runs = { "run-1": run({ projectId: OTHER_PROJECT_ID }) };
    await render();
    expect(mocks.startSpaceOnThisComputer).not.toHaveBeenCalled();
  });

  it("starts nothing outside Desktop, or in a Desktop that can't start a space", async () => {
    mocks.canStart = false;
    await render();
    expect(mocks.startSpaceOnThisComputer).not.toHaveBeenCalled();
  });

  it("starts nothing for a turn that is no waiting Claude Code turn of the person's", async () => {
    for (const runs of [
      {},
      { teammate: run({}, { initiatingUserId: TEAMMATE_ID }) },
      { taken: run({ status: "in_progress" }) },
      { unstamped: run({}, { aiAccessMode: "managed", claudeCode: undefined }) },
      { recorded: run({}, { claudeCode: { version: 2 } }) },
      { elsewhere: run({ projectId: OTHER_PROJECT_ID }) },
    ]) {
      mocks.runs = runs;
      await render();
    }
    expect(mocks.startSpaceOnThisComputer).not.toHaveBeenCalled();
  });
});

describe("isWaitingClaudeCodeTurnOf", () => {
  it("reads only the controller's stamp and its initiating person", () => {
    expect(isWaitingClaudeCodeTurnOf(run(), PROJECT_ID, USER_ID)).toBe(true);
    expect(isWaitingClaudeCodeTurnOf(run({ projectId: null }), PROJECT_ID, USER_ID)).toBe(true);
    expect(isWaitingClaudeCodeTurnOf(run(), PROJECT_ID, TEAMMATE_ID)).toBe(false);
    expect(isWaitingClaudeCodeTurnOf(run({ metadata: null }), PROJECT_ID, USER_ID)).toBe(false);
    expect(isWaitingClaudeCodeTurnOf(run({}, { initiatingUserId: undefined }), PROJECT_ID, USER_ID)).toBe(false);
  });
});
