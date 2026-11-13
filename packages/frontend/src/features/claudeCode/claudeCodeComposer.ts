import type {
  FrontendTurnEngineSendDecision,
  FrontendTurnEngineSendInput,
} from "../frontendFeatureModule";
import type { RuntimeMenuOption } from "../../runtime/useRuntimeMenu";
import { runtimeEntryIsDispatchable } from "../../runtime/utils/runtimeEntry";
import type {
  ControllerRuntimeClaudeCode,
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
} from "../../services/runtimeController/runtimes";
import { CLAUDE_CODE_COPY, claudeCodeNotReadySentence } from "./claudeCodeCopy";
import type { ClaudeCodeDesktopStatus } from "./claudeCodeDesktop";

/** The engine id: a send's claim, and the `aiAccessMode` of the turn's messages. */
export const CLAUDE_CODE_TURN_ENGINE_ID = "claude-code";
/** The only agent a Claude Code turn is for (D1): the sender's own Octo. */
export const CLAUDE_CODE_TARGET_HANDLE = "octo";
/** The controller's and the runtime's prompt limit (G5, 3.9). */
export const CLAUDE_CODE_MAX_PROMPT_CHARS = 100_000;

/** What decides the composer row, read from Desktop, the controller and the runtime menu. */
export interface ClaudeCodeComposerSnapshot {
  /** Null when Studio is not in Desktop, or Desktop said nothing usable. */
  desktopStatus: ClaudeCodeDesktopStatus | null;
  /** The controller's `claudeCodeLane` for this viewer. */
  laneOn: boolean;
  /** The runtime Desktop runs for this space on this computer. */
  thisComputerRuntimeId: string | null;
  runtimeOptions: readonly RuntimeMenuOption[];
  threadKind: string | null;
}

export type ClaudeCodeComposerAvailability =
  | { kind: "hidden" }
  | { kind: "ready"; planSignIn: boolean }
  | {
      kind: "disabled";
      reason: string;
      /** Offer the existing action that starts this space on this computer. */
      startAction: boolean;
      planSignIn: boolean;
    };

function runtimeOptionIsUp(option: RuntimeMenuOption): boolean {
  return option.state === "online" || option.state === "idle";
}

/**
 * Whether the composer offers Claude Code for the next message: only in
 * Desktop where its module is supported (macOS in v1), only for a viewer the
 * lane covers, and choosable only while this computer's own runtime for the
 * space reports `claudeCode.ready` (5.1, 5.3). Otherwise the row shows
 * disabled with its reason.
 */
export function resolveClaudeCodeComposerAvailability(
  snapshot: ClaudeCodeComposerSnapshot,
): ClaudeCodeComposerAvailability {
  if (!snapshot.desktopStatus?.supported || !snapshot.laneOn) {
    return { kind: "hidden" };
  }
  const option = snapshot.thisComputerRuntimeId
    ? snapshot.runtimeOptions.find((candidate) => candidate.id === snapshot.thisComputerRuntimeId) ?? null
    : null;
  const capability: ControllerRuntimeClaudeCode | null = option?.claudeCode ?? null;
  const planSignIn = capability?.planSignIn === true;
  const disabled = (reason: string, startAction = false): ClaudeCodeComposerAvailability => ({
    kind: "disabled",
    reason,
    startAction,
    planSignIn,
  });
  if (snapshot.threadKind) {
    return disabled(CLAUDE_CODE_COPY.inThread);
  }
  if (!snapshot.desktopStatus.consented) {
    return disabled(CLAUDE_CODE_COPY.notSetUp);
  }
  if (!option || !runtimeOptionIsUp(option)) {
    return disabled(CLAUDE_CODE_COPY.notRunningHere, true);
  }
  if (!capability) {
    return disabled(CLAUDE_CODE_COPY.notReadyYet);
  }
  if (!capability.ready) {
    return disabled(claudeCodeNotReadySentence(capability.reason));
  }
  return { kind: "ready", planSignIn };
}

/**
 * The checks a composer Send must pass that need only its own facts, in the
 * order a person fixes them (5.2). Returns the notice of the first that
 * fails, or null.
 */
export function claudeCodeSendBlockNotice(input: FrontendTurnEngineSendInput): string | null {
  if (input.automatic) {
    return CLAUDE_CODE_COPY.sendNotYours;
  }
  if (input.intent === "steer") {
    return CLAUDE_CODE_COPY.sendWhileReplying;
  }
  if (input.intent === "queue") {
    return CLAUDE_CODE_COPY.sendQueued;
  }
  if (input.threadKind) {
    return CLAUDE_CODE_COPY.inThread;
  }
  if (input.browserComposer) {
    return CLAUDE_CODE_COPY.sendFromBrowser;
  }
  if (input.newBrowserTab) {
    return CLAUDE_CODE_COPY.sendNewTab;
  }
  if (input.attachmentCount > 0) {
    return CLAUDE_CODE_COPY.sendAttachments;
  }
  if (input.terminalCommand || input.message.trimStart().startsWith("/")) {
    return CLAUDE_CODE_COPY.sendCommand;
  }
  if (
    !input.requiresAgentTurn ||
    input.targetHandles.length !== 1 ||
    input.targetHandles[0] !== CLAUDE_CODE_TARGET_HANDLE
  ) {
    return CLAUDE_CODE_COPY.sendNotOcto;
  }
  if ([...input.message].length > CLAUDE_CODE_MAX_PROMPT_CHARS) {
    return CLAUDE_CODE_COPY.sendTooLong;
  }
  if (input.chatBusy) {
    return CLAUDE_CODE_COPY.sendWhileReplying;
  }
  if (input.opensInvitePrompt) {
    return CLAUDE_CODE_COPY.sendInvitePrompt;
  }
  return null;
}

export interface ClaudeCodeSendDependencies {
  projectId: string | null;
  fetchRuntimeStatus: (
    params: FetchRuntimeStatusParams,
  ) => Promise<FetchRuntimeStatusResult | null>;
  readDesktopStatus: () => Promise<ClaudeCodeDesktopStatus | null>;
  readThisComputerRuntimeId: (projectId: string) => Promise<string | null>;
  startOnThisComputer: () => void;
}

/**
 * Decides the composer's own Send while Claude Code is chosen for it
 * (`resolveClaudeCodeSubmitRouting` of 5.2). A send that passes goes to this
 * computer's own runtime for the space, pinned for this send only
 * (`preferRuntime: false`), to Octo alone. Readiness is read fresh, so a row
 * that was shown a while ago never sends to a computer that went away; a
 * blocked send never goes to another engine.
 */
export async function resolveClaudeCodeSend(
  input: FrontendTurnEngineSendInput,
  dependencies: ClaudeCodeSendDependencies,
): Promise<FrontendTurnEngineSendDecision> {
  const blocked = (
    notice: string,
    action: { label: string; onAction: () => void } | null = null,
  ): FrontendTurnEngineSendDecision => ({ kind: "blocked", notice, action });
  const notice = claudeCodeSendBlockNotice(input);
  if (notice) {
    return blocked(notice);
  }
  const projectId = dependencies.projectId;
  if (!projectId) {
    return blocked(CLAUDE_CODE_COPY.sendNotChecked);
  }
  const startAction = {
    label: CLAUDE_CODE_COPY.startAction,
    onAction: dependencies.startOnThisComputer,
  };
  const desktopStatus = await dependencies.readDesktopStatus();
  if (!desktopStatus?.supported) {
    return blocked(CLAUDE_CODE_COPY.sendNotChecked);
  }
  if (!desktopStatus.consented) {
    return blocked(CLAUDE_CODE_COPY.notSetUp);
  }
  const runtimeId = await dependencies.readThisComputerRuntimeId(projectId);
  if (!runtimeId) {
    return blocked(CLAUDE_CODE_COPY.sendNotConnected, startAction);
  }
  const status = await dependencies
    .fetchRuntimeStatus({ projectId, quietOnAbort: true })
    .catch(() => null);
  if (!status) {
    return blocked(CLAUDE_CODE_COPY.sendNotChecked);
  }
  if (status.claudeCodeLane !== true) {
    return blocked(CLAUDE_CODE_COPY.sendNotAllowed);
  }
  const entry = status.runtimes.find((candidate) => candidate.runtimeId === runtimeId) ?? null;
  if (!entry || !runtimeEntryIsDispatchable(entry)) {
    return blocked(CLAUDE_CODE_COPY.sendNotConnected, startAction);
  }
  const capability = entry.claudeCode ?? null;
  if (!capability) {
    return blocked(CLAUDE_CODE_COPY.notReadyYet);
  }
  if (!capability.ready) {
    return blocked(claudeCodeNotReadySentence(capability.reason));
  }
  return {
    kind: "route",
    runtimeOverride: {
      runtimeId,
      runtimeDisplayName: null,
      // Pin only this send: this computer never becomes the chat's runtime.
      preferRuntime: false,
    },
    metadata: {
      agentSelection: {
        active: [CLAUDE_CODE_TARGET_HANDLE],
        mentions: [CLAUDE_CODE_TARGET_HANDLE],
      },
    },
  };
}
