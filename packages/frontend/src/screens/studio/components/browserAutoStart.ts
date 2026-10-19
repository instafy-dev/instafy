import type { ControllerRuntimeStatusEntry } from "../../../services/runtimeController";
import { runtimeEntryIsDispatchable } from "../../../runtime/utils/runtimeEntry";
import { hostedRuntimeLimitDetailsFromError } from "../../../runtime/hostedRuntimeLimitError";
import {
  isManagedInstafyCloudProvider,
  listBrowserRuntimeCandidates,
} from "./browserSessionRuntimeEnsure";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

/**
 * How Studio starts a request_browser card by itself (owner decision, Oct 19:
 * Octo opens Instafy's browser on its own, and never starts a second cloud
 * machine to do it).
 *
 * - `reuse`: a browser session already runs in this space.
 * - `personal`: the browser in this desktop app, for a person on their own AI.
 *   The app's one native confirmation stays.
 * - `convert`: this space's one idle standard machine restarts as the browser,
 *   the same machine Studio's limit recycle switches today. Chat turns keep
 *   running on it, so this never doubles the cost; it takes about two minutes
 *   and one billing interval, and the card says so.
 * - `button`: the card stays a button, with the reason when there is one.
 */
export type BrowserAutoStartPlan =
  | { kind: "reuse" }
  | { kind: "personal" }
  | { kind: "convert"; runtimeId: string; projectId: string; provider: string; displayName: string }
  | { kind: "button"; reason: string | null };

export const BROWSER_AUTO_START_COPY = {
  stillWorking: "This space is still working. Open it when you are ready.",
  secondMachine: "This starts a second cloud machine for this space.",
  anotherMachine: "This starts another cloud machine for this space.",
  firstMachine: "This starts a cloud machine for this space.",
  inUseElsewhere: "Your team's cloud machine is in use in another space.",
  inUse: "Instafy's browser is in use. Open it when it is free.",
  severalSessions: "Several browser sessions are running in this space. Open the one you want.",
  boost: "This restarts this space's Boost machine. Open it when you are ready.",
  notReady: "This space's cloud machine is still starting. Open it when it is ready.",
  personalNeedsOwnAi: "The browser on this device needs your own AI connection.",
  converting: "This space's machine restarts with the browser. This takes about two minutes and one billing interval.",
  timedOut: "Instafy's browser did not start in time. Open it from the message to try again.",
} as const;

/** The display name Studio gives the space's own standard hosted machine. */
const GENERIC_HOSTED_RUNTIME_DISPLAY_NAME = "hosted runtime";
const ENDED_RUNTIME_STATUSES = new Set([
  "stopped",
  "stopping",
  "failed",
  "terminated",
  "expired",
  "deleted",
  "removed",
]);

export type BrowserAutoStartPlanInput = {
  /** The browser the card resolved to (see browserRequestTransport). */
  transport: BrowserTransport;
  personalAvailable: boolean;
  /** True only when the person's turns are known to run on their own AI. */
  personalOwnAi: boolean;
  projectId: string | null;
  /** This space's runtimes as the controller last reported them; null when unknown. */
  runtimes: readonly ControllerRuntimeStatusEntry[] | null;
  /** Any run of this space is still working or queued. */
  spaceBusy: boolean;
  /** This space's hosted machine is set to start at Boost size. */
  boost: boolean;
};

function isLiveHostedMachine(entry: ControllerRuntimeStatusEntry): boolean {
  return isManagedInstafyCloudProvider(entry.provider) &&
    entry.isLocal === false &&
    entry.isPrivateSelfHosted !== true &&
    !ENDED_RUNTIME_STATUSES.has(entry.status.trim().toLowerCase());
}

/** What Studio may do by itself for a card, from the cost table of the plan. */
export function browserAutoStartPlan(input: BrowserAutoStartPlanInput): BrowserAutoStartPlan {
  if (input.transport === "personal") {
    if (!input.personalAvailable) return { kind: "button", reason: null };
    return input.personalOwnAi
      ? { kind: "personal" }
      : { kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi };
  }
  const projectId = input.projectId?.trim() ?? "";
  if (!projectId || !input.runtimes) return { kind: "button", reason: null };
  const sessions = listBrowserRuntimeCandidates([...input.runtimes]);
  if (sessions.length === 1) return { kind: "reuse" };
  if (sessions.length > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.severalSessions };
  const machines = input.runtimes.filter(isLiveHostedMachine);
  // Without a cloud machine in this space Studio cannot tell whether a browser
  // can start here at all (a self-hosted deployment may have none), and
  // starting one would add a machine: the person decides.
  if (machines.length === 0) return { kind: "button", reason: BROWSER_AUTO_START_COPY.firstMachine };
  if (machines.length > 1) return { kind: "button", reason: BROWSER_AUTO_START_COPY.anotherMachine };
  const machine = machines[0]!;
  const displayName = machine.displayName?.trim() ?? "";
  if (displayName.toLowerCase() !== GENERIC_HOSTED_RUNTIME_DISPLAY_NAME) {
    return { kind: "button", reason: BROWSER_AUTO_START_COPY.secondMachine };
  }
  if (input.boost) return { kind: "button", reason: BROWSER_AUTO_START_COPY.boost };
  if (input.spaceBusy) return { kind: "button", reason: BROWSER_AUTO_START_COPY.stillWorking };
  if (!runtimeEntryIsDispatchable(machine)) return { kind: "button", reason: BROWSER_AUTO_START_COPY.notReady };
  return {
    kind: "convert",
    runtimeId: machine.runtimeId,
    projectId,
    provider: machine.provider.trim(),
    displayName,
  };
}

/** The card's reason when an automatic start failed. */
export function browserAutoStartFailureReason(error: unknown, projectId: string | null): string {
  const limit = hostedRuntimeLimitDetailsFromError(error);
  if (limit) {
    const blocker = limit.blockerProjectId?.trim() ?? "";
    return blocker && blocker !== (projectId?.trim() ?? "")
      ? BROWSER_AUTO_START_COPY.inUseElsewhere
      : BROWSER_AUTO_START_COPY.secondMachine;
  }
  const message = error instanceof Error ? error.message.trim() : "";
  return message || BROWSER_AUTO_START_COPY.timedOut;
}

/**
 * Whether Studio answers a Shared Browser approval prompt with routine
 * browsing for the person (owner decision, Oct 19: routine browsing is free
 * inside a browser Octo opened by itself). Only the first site prompt of a run
 * this page started by itself, for the person who started it, once, and only
 * where the runtime offers routine browsing. Every action prompt, for a
 * purchase, a submission or an activation key, still waits for the person.
 */
export function shouldAllowRoutineBrowsingForAutoStart(input: {
  request: { kind: string; runId: string; initiatorUserId: string; approvalId: string } | null;
  routineAvailable: boolean;
  currentUserId: string | null;
  autoStartedRunIds: ReadonlySet<string> | null;
  alreadyDecidedApprovalId: string | null;
}): boolean {
  const request = input.request;
  return Boolean(
    request &&
      request.kind === "origin" &&
      input.routineAvailable &&
      input.currentUserId &&
      request.initiatorUserId === input.currentUserId &&
      input.autoStartedRunIds?.has(request.runId) &&
      request.approvalId !== input.alreadyDecidedApprovalId,
  );
}

// What this page remembers about automatic starts, in module memory only like
// the sent-prompt registry: a reload, another tab and another device start
// empty, and none of them can start a card they did not ask for anyway.
const claimedCards = new Set<string>();
const autoStartedAt = new Map<string, number>();
const declinedConversations = new Set<string>();
const MAX_REMEMBERED = 500;

/** One automatic start per conversation in this window. */
export const BROWSER_AUTO_START_CONVERSATION_WINDOW_MS = 10 * 60_000;

function remember<T>(collection: Set<T> | Map<T, unknown>) {
  while (collection.size > MAX_REMEMBERED) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) break;
    collection.delete(oldest);
  }
}

/** Claims a card once for this page, by its key; false when already claimed. */
export function claimBrowserAutoStart(cardKey: string): boolean {
  if (!cardKey || claimedCards.has(cardKey)) return false;
  claimedCards.add(cardKey);
  remember(claimedCards);
  return true;
}

export function isBrowserAutoStartClaimed(cardKey: string): boolean {
  return claimedCards.has(cardKey);
}

export function recordBrowserAutoStart(conversationKey: string, now = Date.now()): void {
  autoStartedAt.delete(conversationKey);
  autoStartedAt.set(conversationKey, now);
  remember(autoStartedAt);
}

/** True while this conversation's last automatic start is within the window. */
export function browserAutoStartedRecently(conversationKey: string, now = Date.now()): boolean {
  const at = autoStartedAt.get(conversationKey);
  return at !== undefined && now - at < BROWSER_AUTO_START_CONVERSATION_WINDOW_MS;
}

/** True once Studio opened the browser by itself in this conversation, on this page. */
export function wasBrowserAutoStarted(conversationKey: string): boolean {
  return autoStartedAt.has(conversationKey);
}

/** The person closed, paused or stopped the browser in this conversation. */
export function markBrowserAutoStartDeclined(conversationKey: string): void {
  if (!conversationKey) return;
  declinedConversations.add(conversationKey);
  remember(declinedConversations);
}

export function isBrowserAutoStartDeclined(conversationKey: string): boolean {
  return declinedConversations.has(conversationKey);
}

/** Empties what this page remembers, as a reload would. Tests only. */
export function forgetBrowserAutoStartsForTests(): void {
  claimedCards.clear();
  autoStartedAt.clear();
  declinedConversations.clear();
}
