import { describe, expect, it, vi } from "vitest";
import type { FrontendTurnEngineSendInput } from "../../frontendFeatureModule";
import type { RuntimeMenuOption } from "../../../runtime/useRuntimeMenu";
import type {
  ControllerRuntimeClaudeCode,
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController/runtimes";
import { CLAUDE_CODE_COPY } from "../claudeCodeCopy";
import {
  CLAUDE_CODE_MAX_PROMPT_CHARS,
  resolveClaudeCodeComposerAvailability,
  resolveClaudeCodeSend,
  type ClaudeCodeComposerSnapshot,
  type ClaudeCodeSendDependencies,
} from "../claudeCodeComposer";

const RUNTIME_ID = "11111111-2222-4333-8444-555555555555";
const PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const READY: ControllerRuntimeClaudeCode = {
  ready: true,
  reason: null,
  cli: "2.1.314",
  verified: true,
  planSignIn: false,
};

function option(overrides: Partial<RuntimeMenuOption> = {}): RuntimeMenuOption {
  return {
    id: RUNTIME_ID,
    label: "This computer",
    detail: null,
    state: "online",
    badge: null,
    isSessionOverride: false,
    tunnel: null,
    needsActivation: false,
    isLikelyLocal: true,
    claudeCode: READY,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ClaudeCodeComposerSnapshot> = {}): ClaudeCodeComposerSnapshot {
  return {
    desktopStatus: { supported: true, found: true, path: null, consented: true },
    laneOn: true,
    thisComputerRuntimeId: RUNTIME_ID,
    runtimeOptions: [option()],
    threadKind: null,
    ...overrides,
  };
}

describe("resolveClaudeCodeComposerAvailability", () => {
  it("offers nothing outside Desktop, where Desktop does not support it, or without the lane", () => {
    expect(resolveClaudeCodeComposerAvailability(snapshot({ desktopStatus: null }))).toEqual({ kind: "hidden" });
    expect(
      resolveClaudeCodeComposerAvailability(
        snapshot({ desktopStatus: { supported: false, found: true, path: null, consented: true } }),
      ),
    ).toEqual({ kind: "hidden" });
    expect(resolveClaudeCodeComposerAvailability(snapshot({ laneOn: false }))).toEqual({ kind: "hidden" });
  });

  it("can be chosen only while this computer's own runtime reports Claude Code ready", () => {
    expect(resolveClaudeCodeComposerAvailability(snapshot())).toEqual({ kind: "ready", planSignIn: false });
    expect(
      resolveClaudeCodeComposerAvailability(
        snapshot({ runtimeOptions: [option({ claudeCode: { ...READY, planSignIn: true } })] }),
      ),
    ).toEqual({ kind: "ready", planSignIn: true });
    // Another runtime of the space that is ready is not this computer's.
    expect(
      resolveClaudeCodeComposerAvailability(
        snapshot({ runtimeOptions: [option({ id: "other-runtime" })] }),
      ),
    ).toMatchObject({ kind: "disabled", reason: CLAUDE_CODE_COPY.notRunningHere, startAction: true });
  });

  it("shows the row disabled, with its reason, in every other case", () => {
    expect(resolveClaudeCodeComposerAvailability(snapshot({ threadKind: "agent" }))).toMatchObject({
      kind: "disabled",
      reason: CLAUDE_CODE_COPY.inThread,
    });
    expect(
      resolveClaudeCodeComposerAvailability(
        snapshot({ desktopStatus: { supported: true, found: false, path: null, consented: false } }),
      ),
    ).toMatchObject({ kind: "disabled", reason: CLAUDE_CODE_COPY.notSetUp, startAction: false });
    expect(resolveClaudeCodeComposerAvailability(snapshot({ thisComputerRuntimeId: null }))).toMatchObject({
      kind: "disabled",
      reason: CLAUDE_CODE_COPY.notRunningHere,
      startAction: true,
    });
    expect(
      resolveClaudeCodeComposerAvailability(snapshot({ runtimeOptions: [option({ state: "offline" })] })),
    ).toMatchObject({ kind: "disabled", reason: CLAUDE_CODE_COPY.notRunningHere, startAction: true });
    expect(
      resolveClaudeCodeComposerAvailability(snapshot({ runtimeOptions: [option({ claudeCode: null })] })),
    ).toMatchObject({ kind: "disabled", reason: CLAUDE_CODE_COPY.notReadyYet });
    expect(
      resolveClaudeCodeComposerAvailability(
        snapshot({
          runtimeOptions: [
            option({ claudeCode: { ...READY, ready: false, reason: "unsupported_version" } }),
          ],
        }),
      ),
    ).toMatchObject({ kind: "disabled", reason: CLAUDE_CODE_COPY.notReady.unsupported_version });
    expect(
      resolveClaudeCodeComposerAvailability(
        snapshot({ runtimeOptions: [option({ claudeCode: { ...READY, ready: false, reason: null } })] }),
      ),
    ).toMatchObject({ kind: "disabled", reason: CLAUDE_CODE_COPY.notReadyYet });
  });
});

function sendInput(overrides: Partial<FrontendTurnEngineSendInput> = {}): FrontendTurnEngineSendInput {
  return {
    message: "Fix the failing login test",
    intent: "send",
    automatic: false,
    requiresAgentTurn: true,
    terminalCommand: false,
    attachmentCount: 0,
    threadKind: null,
    targetHandles: ["octo"],
    browserComposer: false,
    newBrowserTab: false,
    chatBusy: false,
    opensInvitePrompt: false,
    ...overrides,
  };
}

function statusEntry(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return {
    runtimeId: RUNTIME_ID,
    status: "ready",
    provider: "self-hosted",
    idleTtlSeconds: 600,
    isLocal: true,
    isPreferred: false,
    health: "online",
    lastSeenAt: new Date().toISOString(),
    claudeCode: READY,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<ClaudeCodeSendDependencies> & { status?: FetchRuntimeStatusResult | null } = {},
) {
  const { status, ...rest } = overrides;
  const fetchRuntimeStatus = vi.fn(async () =>
    status === undefined
      ? ({ runtimes: [statusEntry()], preferredRuntimeId: null, claudeCodeLane: true } as FetchRuntimeStatusResult)
      : status,
  );
  return {
    projectId: PROJECT_ID,
    fetchRuntimeStatus,
    readDesktopStatus: vi.fn(async () => ({ supported: true, found: true, path: null, consented: true })),
    readThisComputerRuntimeId: vi.fn(async () => RUNTIME_ID),
    startOnThisComputer: vi.fn(),
    ...rest,
  } satisfies ClaudeCodeSendDependencies;
}

describe("resolveClaudeCodeSend", () => {
  it("routes a plain message to Octo on this computer's runtime, for this send only", async () => {
    const deps = dependencies();
    await expect(resolveClaudeCodeSend(sendInput(), deps)).resolves.toEqual({
      kind: "route",
      runtimeOverride: { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false },
      metadata: { agentSelection: { active: ["octo"], mentions: ["octo"] } },
    });
    // Readiness is read fresh at send time.
    expect(deps.fetchRuntimeStatus).toHaveBeenCalledWith({ projectId: PROJECT_ID, quietOnAbort: true });
    expect(deps.readThisComputerRuntimeId).toHaveBeenCalledWith(PROJECT_ID);
  });

  it.each([
    ["an automatic send", { automatic: true }, CLAUDE_CODE_COPY.sendNotYours],
    ["Steer", { intent: "steer" as const }, CLAUDE_CODE_COPY.sendWhileReplying],
    ["Queue", { intent: "queue" as const }, CLAUDE_CODE_COPY.sendQueued],
    ["a thread", { threadKind: "thread" }, CLAUDE_CODE_COPY.inThread],
    ["a browser's own composer", { browserComposer: true }, CLAUDE_CODE_COPY.sendFromBrowser],
    ["a pending new tab", { newBrowserTab: true }, CLAUDE_CODE_COPY.sendNewTab],
    ["attachments", { attachmentCount: 1 }, CLAUDE_CODE_COPY.sendAttachments],
    ["a / command", { message: "  /goal ship it" }, CLAUDE_CODE_COPY.sendCommand],
    ["a terminal command", { terminalCommand: true }, CLAUDE_CODE_COPY.sendCommand],
    ["a message that starts no agent turn", { requiresAgentTurn: false }, CLAUDE_CODE_COPY.sendNotOcto],
    ["another agent", { targetHandles: ["designer"] }, CLAUDE_CODE_COPY.sendNotOcto],
    ["two agents", { targetHandles: ["octo", "designer"] }, CLAUDE_CODE_COPY.sendNotOcto],
    ["text over the limit", { message: "a".repeat(CLAUDE_CODE_MAX_PROMPT_CHARS + 1) }, CLAUDE_CODE_COPY.sendTooLong],
    ["a busy chat", { chatBusy: true }, CLAUDE_CODE_COPY.sendWhileReplying],
    ["a private chat's invite prompt", { opensInvitePrompt: true }, CLAUDE_CODE_COPY.sendInvitePrompt],
  ])("blocks %s before asking Desktop or the controller", async (_case, overrides, notice) => {
    const deps = dependencies();
    await expect(resolveClaudeCodeSend(sendInput(overrides), deps)).resolves.toEqual({
      kind: "blocked",
      notice,
      action: null,
    });
    expect(deps.readDesktopStatus).not.toHaveBeenCalled();
    expect(deps.fetchRuntimeStatus).not.toHaveBeenCalled();
  });

  it("takes exactly the limit", async () => {
    await expect(
      resolveClaudeCodeSend(sendInput({ message: "a".repeat(CLAUDE_CODE_MAX_PROMPT_CHARS) }), dependencies()),
    ).resolves.toMatchObject({ kind: "route" });
  });

  it("blocks a send whose computer is not ready, with the reason", async () => {
    const notConsented = dependencies({
      readDesktopStatus: vi.fn(async () => ({ supported: true, found: true, path: null, consented: false })),
    });
    await expect(resolveClaudeCodeSend(sendInput(), notConsented)).resolves.toMatchObject({
      kind: "blocked",
      notice: CLAUDE_CODE_COPY.notSetUp,
    });

    const notRunning = dependencies({ readThisComputerRuntimeId: vi.fn(async () => null) });
    const notRunningDecision = await resolveClaudeCodeSend(sendInput(), notRunning);
    expect(notRunningDecision).toMatchObject({
      kind: "blocked",
      notice: CLAUDE_CODE_COPY.sendNotConnected,
      action: { label: CLAUDE_CODE_COPY.startAction },
    });
    if (notRunningDecision.kind === "blocked") {
      notRunningDecision.action?.onAction();
    }
    expect(notRunning.startOnThisComputer).toHaveBeenCalledOnce();

    await expect(
      resolveClaudeCodeSend(sendInput(), dependencies({ status: null })),
    ).resolves.toMatchObject({ kind: "blocked", notice: CLAUDE_CODE_COPY.sendNotChecked });
    await expect(
      resolveClaudeCodeSend(
        sendInput(),
        dependencies({ status: { runtimes: [statusEntry()], preferredRuntimeId: null } }),
      ),
    ).resolves.toMatchObject({ kind: "blocked", notice: CLAUDE_CODE_COPY.sendNotAllowed });
    await expect(
      resolveClaudeCodeSend(
        sendInput(),
        dependencies({
          status: { runtimes: [statusEntry({ health: "offline" })], preferredRuntimeId: null, claudeCodeLane: true },
        }),
      ),
    ).resolves.toMatchObject({ kind: "blocked", notice: CLAUDE_CODE_COPY.sendNotConnected });
    await expect(
      resolveClaudeCodeSend(
        sendInput(),
        dependencies({
          status: {
            runtimes: [statusEntry({ claudeCode: { ...READY, ready: false, reason: "binary_missing" } })],
            preferredRuntimeId: null,
            claudeCodeLane: true,
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: "blocked", notice: CLAUDE_CODE_COPY.notReady.binary_missing });
    await expect(
      resolveClaudeCodeSend(
        sendInput(),
        dependencies({
          status: { runtimes: [statusEntry({ claudeCode: undefined })], preferredRuntimeId: null, claudeCodeLane: true },
        }),
      ),
    ).resolves.toMatchObject({ kind: "blocked", notice: CLAUDE_CODE_COPY.notReadyYet });
    await expect(
      resolveClaudeCodeSend(
        sendInput(),
        dependencies({ readDesktopStatus: vi.fn(async () => null) }),
      ),
    ).resolves.toMatchObject({ kind: "blocked", notice: CLAUDE_CODE_COPY.sendNotChecked });
  });
});
