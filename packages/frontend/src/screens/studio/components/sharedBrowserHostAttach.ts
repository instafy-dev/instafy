import type {
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
  SharedBrowserHostPolicy,
} from "../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";
import { runtimeEntryIsDispatchable } from "../../../runtime/utils/runtimeEntry";
import { runtimeDebugLog } from "../../../runtime/utils/runtimeDebug";
import type { HostedBrowserErrorKind } from "./hostedBrowserViewState";
import {
  isManagedInstafyCloudProvider,
  listBrowserRuntimeCandidates,
  runtimeEntryIsLazyBrowserHost,
  runtimeEntryLooksLikeBrowserSession,
  type BrowserRuntimeCandidate,
  type BrowserRuntimeSelection,
} from "./browserSessionRuntimeEnsure";

/**
 * Opening Instafy's browser on the space's own machine ("attach"). The
 * machine starts its browser on demand: Studio asks for it and waits until it
 * is ready, and never starts, stops or replaces a machine to do it, except
 * for a person's press when the space's machine is not running (the cold
 * path below).
 *
 * The browser view shows one of these sentences at a time (see
 * hostedBrowserViewState): short, plain, and without em dashes.
 */
export const SHARED_BROWSER_HOST_COPY = {
  off: "Instafy's browser is off.",
  opening: "Opening Instafy's browser…",
  didNotOpen: "Instafy's browser did not open. Try again.",
  machineDidNotStart: "This space's machine did not start. Try again.",
  askBuilder: "Ask a space builder to open Instafy's browser.",
  poisoned: "Instafy's browser needs this space's machine to restart before it can open again.",
  policyOff: "Instafy's browser is turned off for this space.",
} as const;

export const SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS = 120_000;
export const SHARED_BROWSER_HOST_POLL_MS = 500;
export const SHARED_BROWSER_HOST_STOPPING_RETRY_MS = 1_000;
export const SPACE_MACHINE_COLD_START_TIMEOUT_MS = 180_000;
export const SPACE_MACHINE_COLD_START_POLL_MS = 2_000;
/**
 * One read or start of Instafy's browser that has not answered by then is
 * given up and polled again, so a hung request cannot outlast the wait.
 */
export const SHARED_BROWSER_HOST_REQUEST_TIMEOUT_MS = 10_000;
/** Starts asked for in one wait; a browser that keeps failing is not retried forever. */
const SHARED_BROWSER_HOST_MAX_START_REQUESTS = 3;

type SharedBrowserHostRequest = {
  projectId: string;
  runtimeId: string;
  browserSessionId: string;
  signal?: AbortSignal;
};

export interface SharedBrowserHostClient {
  fetchHost: (params: SharedBrowserHostRequest) => Promise<SharedBrowserHostSnapshot | null>;
  startHost: (params: SharedBrowserHostRequest) => Promise<SharedBrowserHostSnapshot | null>;
  isUnavailableError: (error: unknown) => boolean;
  /** A start refused with 409; its `code` says why. */
  isHostRefusedError: (error: unknown) => boolean;
}

/**
 * An error carries the view state it leads to (`errorKind`) and its reason:
 * for `blocked` the sentence the view shows, otherwise a short technical
 * reason that only runtime debug shows.
 */
export type SharedBrowserHostWaitError = {
  kind: "error";
  errorKind: Exclude<HostedBrowserErrorKind, "notice">;
  reason: string;
};

export type SharedBrowserHostWaitResult =
  | { kind: "ready"; snapshot: SharedBrowserHostSnapshot }
  | SharedBrowserHostWaitError
  | { kind: "cancelled" };

function hostWaitError(errorKind: SharedBrowserHostWaitError["errorKind"], reason: string): SharedBrowserHostWaitError {
  return { kind: "error", errorKind, reason };
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<boolean>;

export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      resolve(completed);
    };
    const handleAbort = () => finish(false);
    const timer = globalThis.setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function isTokenError(error: unknown): boolean {
  return error instanceof Error && error.name === "SharedBrowserHostTokenError";
}

/** The controller's 404 `code` while the space's hosted browser policy is off. */
const POLICY_OFF_CODE = "browser_host_policy_off";

/**
 * A 404 that is not the machine's own "no browser host" answer, with its
 * code (null without one); undefined for any other error.
 */
function hostNotFoundCode(error: unknown): string | null | undefined {
  if (!(error instanceof Error) || error.name !== "SharedBrowserHostNotFoundError") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** A read or start of Instafy's browser that did not answer in time; polled like a gateway error. */
export class SharedBrowserHostRequestTimeoutError extends Error {
  constructor() {
    super("Instafy's browser did not answer in time.");
    this.name = "SharedBrowserHostRequestTimeoutError";
  }
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof SharedBrowserHostRequestTimeoutError;
}

/**
 * Runs one request with its own signal, aborted with the caller's and after
 * `timeoutMs`; a request that ignores its signal still ends then.
 */
async function requestWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const abortWithParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener("abort", abortWithParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SharedBrowserHostRequestTimeoutError());
    }, Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abortWithParent);
  }
}

/**
 * Waits until Instafy's browser on the space's machine is ready, starting it
 * when it is idle or has failed and the person may control the browser.
 * With `mayStart: false` (an automatic reconnect) it never starts it: an idle
 * browser is off, a failed one did not open.
 *
 * | state                            | action                                   |
 * |----------------------------------|------------------------------------------|
 * | ready                            | done                                     |
 * | idle, failed                     | start (control) or ask a builder (view)  |
 * | starting, stopping, unknown      | poll again                               |
 * | poisoned                         | blocked: the machine must restart        |
 * | no host (the machine's own 404)  | off                                      |
 * | policy off (`browser_host_policy_off`) | blocked: turned off for this space |
 *
 * A start refused with `browser_host_stopping` or `machine_stopping` is asked
 * again after a second, within the start budget.
 * Gateway errors (502, 503, 504), any other 404 (the controller or something
 * in front of it, logged as `browser-session:host-404`), token failures and a
 * read or start that has not answered in ten seconds are polled through; the
 * whole wait is capped, and no request outlasts it.
 */
export async function waitForSharedBrowserHostReady(params: {
  projectId: string;
  runtimeId: string;
  browserSessionId: string;
  canControl: boolean;
  /** False for an automatic reconnect: it never starts the browser. */
  mayStart?: boolean;
  client: SharedBrowserHostClient;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  stoppingRetryMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: Sleep;
}): Promise<SharedBrowserHostWaitResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? sleepUnlessAborted;
  const pollMs = params.pollMs ?? SHARED_BROWSER_HOST_POLL_MS;
  const stoppingRetryMs = params.stoppingRetryMs ?? SHARED_BROWSER_HOST_STOPPING_RETRY_MS;
  const deadline = now() + (params.timeoutMs ?? SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS);
  const requestTimeoutMs = params.requestTimeoutMs ?? SHARED_BROWSER_HOST_REQUEST_TIMEOUT_MS;
  const request = (signal: AbortSignal): SharedBrowserHostRequest => ({
    projectId: params.projectId,
    runtimeId: params.runtimeId,
    browserSessionId: params.browserSessionId,
    signal,
  });
  // Each request ends at its own bound or at the end of the wait, whichever
  // comes first.
  const bounded = <T>(call: (request: SharedBrowserHostRequest) => Promise<T>): Promise<T> =>
    requestWithTimeout(
      (signal) => call(request(signal)),
      params.signal,
      Math.min(requestTimeoutMs, Math.max(0, deadline - now())),
    );
  let startRequests = 0;
  const cancelled = () => params.signal?.aborted === true;
  const pause = async (ms: number): Promise<boolean> => {
    const remaining = deadline - now();
    if (remaining <= 0) return true;
    return sleep(Math.min(ms, remaining), params.signal);
  };

  // A 404 that is not the machine's own answer: the policy-off code ends the
  // wait; any other is polled through (the controller restarting, a proxy).
  const notFoundOutcome = (error: unknown): SharedBrowserHostWaitResult | "poll" | null => {
    const code = hostNotFoundCode(error);
    if (code === undefined) return null;
    if (code === POLICY_OFF_CODE) {
      return hostWaitError("blocked", SHARED_BROWSER_HOST_COPY.policyOff);
    }
    runtimeDebugLog("browser-session:host-404", { status: 404, code });
    return "poll";
  };

  while (!cancelled() && now() < deadline) {
    let snapshot: SharedBrowserHostSnapshot | null;
    try {
      snapshot = await bounded((value) => params.client.fetchHost(value));
    } catch (error) {
      if (cancelled()) break;
      const notFound = notFoundOutcome(error);
      if (notFound && notFound !== "poll") return notFound;
      if (notFound === "poll" || params.client.isUnavailableError(error) || isTokenError(error) || isRequestTimeout(error)) {
        if (!(await pause(pollMs))) break;
        continue;
      }
      return hostWaitError("failed", error instanceof Error ? error.message : String(error));
    }
    if (cancelled()) break;
    if (!snapshot) {
      return hostWaitError("off", "no browser host on this machine");
    }
    if (snapshot.state === "ready") {
      return { kind: "ready", snapshot };
    }
    if (snapshot.state === "poisoned") {
      return hostWaitError("blocked", SHARED_BROWSER_HOST_COPY.poisoned);
    }
    if (snapshot.state === "idle" || snapshot.state === "failed") {
      if (!params.canControl) {
        return hostWaitError("blocked", SHARED_BROWSER_HOST_COPY.askBuilder);
      }
      if (params.mayStart === false) {
        return snapshot.state === "idle"
          ? hostWaitError("off", "browser host idle; a reconnect does not start it")
          : hostWaitError("failed", `browser host failed${snapshot.failure ? ` (${snapshot.failure})` : ""}`);
      }
      // A failure after a start asked for here is this wait's answer.
      if (snapshot.state === "failed" && startRequests > 0) {
        return hostWaitError("failed", `browser host failed after a start${snapshot.failure ? ` (${snapshot.failure})` : ""}`);
      }
      if (startRequests >= SHARED_BROWSER_HOST_MAX_START_REQUESTS) {
        return hostWaitError("failed", "browser host start budget used");
      }
      startRequests += 1;
      try {
        const started = await bounded((value) => params.client.startHost(value));
        if (cancelled()) break;
        if (started?.state === "ready") {
          return { kind: "ready", snapshot: started };
        }
      } catch (error) {
        if (cancelled()) break;
        if (params.client.isHostRefusedError(error)) {
          const code = (error as { code?: unknown }).code;
          // A browser or machine that is stopping is still opening: asked
          // again shortly, within the start budget.
          if (code === "browser_host_stopping" || code === "machine_stopping") {
            if (!(await pause(stoppingRetryMs))) break;
            continue;
          }
          if (code === "browser_host_poisoned") {
            return hostWaitError("blocked", SHARED_BROWSER_HOST_COPY.poisoned);
          }
          return hostWaitError("failed", `browser host start refused (${typeof code === "string" ? code : "no code"})`);
        }
        const notFound = notFoundOutcome(error);
        if (notFound && notFound !== "poll") return notFound;
        if (!notFound && !params.client.isUnavailableError(error) && !isTokenError(error) && !isRequestTimeout(error)) {
          return hostWaitError("failed", error instanceof Error ? error.message : String(error));
        }
      }
    }
    // starting, stopping, unknown, or a start just asked for.
    if (!(await pause(pollMs))) break;
  }
  if (cancelled()) {
    return { kind: "cancelled" };
  }
  return hostWaitError("failed", "browser host wait timed out");
}

/**
 * Whether a press should start this space's machine and open its browser:
 * the space is covered, and either nothing is open to resume (`new`), or the
 * exact pin names the space's own (non-session) managed machine while it is
 * not running or no longer listed. It runs before the `missing` error.
 */
export function shouldStartSpaceMachineForBrowser(input: {
  policy: SharedBrowserHostPolicy | null;
  selection: BrowserRuntimeSelection;
  exactRuntimeId: string | null;
  entries: readonly ControllerRuntimeStatusEntry[];
}): boolean {
  if (input.policy !== "covered") return false;
  if (input.selection.kind === "new") return true;
  if (input.selection.kind !== "missing" || !input.exactRuntimeId) return false;
  const pinned = input.entries.find((entry) => entry.runtimeId === input.exactRuntimeId);
  if (!pinned) return true;
  return runtimeEntryIsSpaceMachine(pinned) && !runtimeEntryIsDispatchable(pinned);
}

/**
 * The space's own Instafy Cloud machine: managed, not private, and not a
 * separate browser session. The person's Desktop or self-hosted machine is
 * never one, even when the conversation runs on it.
 */
export function runtimeEntryIsSpaceMachine(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): entry is ControllerRuntimeStatusEntry {
  return Boolean(entry) &&
    isManagedInstafyCloudProvider(entry!.provider) &&
    entry!.isPrivateSelfHosted !== true &&
    !runtimeEntryLooksLikeBrowserSession(entry);
}

/** A live lazy host to resume in place of a stale pin, when there is one. */
export function liveSharedBrowserHostCandidate(
  entries: readonly ControllerRuntimeStatusEntry[],
): BrowserRuntimeCandidate | null {
  return listBrowserRuntimeCandidates([...entries]).find((candidate) => candidate.mode === "lazy") ?? null;
}

export type SpaceMachineColdStartResult =
  | { kind: "attach"; candidate: BrowserRuntimeCandidate }
  | { kind: "legacy" }
  | { kind: "error"; errorKind: "machine"; reason: string }
  | { kind: "cancelled" };

/**
 * The cold path for a press: start the space's machine, then wait until it
 * is dispatchable. The target is the pinned machine, else the conversation's
 * machine, each only when it is listed and is the space's own machine (never
 * a Desktop, self-hosted or browser session machine). Otherwise it is the
 * first live lazy host. A target that comes up without `sharedBrowserHost`
 * (an image or lease that is not attested for it) goes back to the legacy
 * path at once; registration writes status and capabilities together, so
 * there is nothing to wait for.
 */
export async function startSpaceMachineForBrowser(params: {
  projectId: string;
  pinnedRuntimeId: string | null;
  conversationRuntimeId: string | null;
  ensureSpaceMachine: () => Promise<boolean>;
  fetchStatus: (params: FetchRuntimeStatusParams) => Promise<FetchRuntimeStatusResult | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: Sleep;
}): Promise<SpaceMachineColdStartResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? sleepUnlessAborted;
  const pollMs = params.pollMs ?? SPACE_MACHINE_COLD_START_POLL_MS;
  const deadline = now() + (params.timeoutMs ?? SPACE_MACHINE_COLD_START_TIMEOUT_MS);
  const cancelled = () => params.signal?.aborted === true;
  let ensured = false;
  try {
    ensured = await params.ensureSpaceMachine();
  } catch {
    ensured = false;
  }
  if (cancelled()) return { kind: "cancelled" };
  if (!ensured) return { kind: "error", errorKind: "machine", reason: "space machine ensure failed" };

  while (!cancelled() && now() < deadline) {
    const status = await params.fetchStatus({
      projectId: params.projectId,
      signal: params.signal,
      quietOnAbort: true,
    }).catch(() => null);
    if (cancelled()) break;
    const entries = Array.isArray(status?.runtimes) ? status.runtimes : [];
    const listedSpaceMachine = (runtimeId: string | null) => {
      const entry = runtimeId ? entries.find((item) => item.runtimeId === runtimeId) : undefined;
      return runtimeEntryIsSpaceMachine(entry) ? entry : null;
    };
    const target =
      listedSpaceMachine(params.pinnedRuntimeId) ??
      listedSpaceMachine(params.conversationRuntimeId) ??
      entries.find((entry) =>
        runtimeEntryIsSpaceMachine(entry) &&
        runtimeEntryIsLazyBrowserHost(entry) &&
        runtimeEntryIsDispatchable(entry)) ??
      null;
    if (target && runtimeEntryIsDispatchable(target)) {
      if (!runtimeEntryIsLazyBrowserHost(target)) {
        return { kind: "legacy" };
      }
      const candidate = listBrowserRuntimeCandidates([target])[0];
      if (candidate?.mode === "lazy") {
        return { kind: "attach", candidate };
      }
      // Dispatchable but without an origin yet: poll on.
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    if (!(await sleep(Math.min(pollMs, remaining), params.signal))) break;
  }
  if (cancelled()) return { kind: "cancelled" };
  return { kind: "error", errorKind: "machine", reason: "space machine did not come up in time" };
}
