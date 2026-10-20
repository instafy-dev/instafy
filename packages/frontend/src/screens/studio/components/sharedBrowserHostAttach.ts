import type {
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
  SharedBrowserHostPolicy,
} from "../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";
import { runtimeEntryIsDispatchable } from "../../../runtime/utils/runtimeEntry";
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
 */
export const SHARED_BROWSER_HOST_COPY = {
  askBuilder: "Ask a space builder to open Instafy's browser.",
  poisoned: "Instafy's browser needs this space's machine to restart before it can open again.",
  didNotStart: "Instafy's browser did not start. Try again.",
  machineStopping: "This space's machine is stopping. Try again in a moment.",
  notAvailable: "Instafy's browser is not available on this space's machine right now. Try again.",
  machineStopped: "This space's machine stopped. Open the browser to start it.",
  machineNotRunning: "This space's machine is not running. Press Retry to start it.",
  machineDidNotStart: "This space's machine did not start. Try again.",
} as const;

export const SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS = 120_000;
export const SHARED_BROWSER_HOST_POLL_MS = 500;
export const SHARED_BROWSER_HOST_STOPPING_RETRY_MS = 1_000;
export const SPACE_MACHINE_COLD_START_TIMEOUT_MS = 180_000;
export const SPACE_MACHINE_COLD_START_POLL_MS = 2_000;
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

export type SharedBrowserHostWaitResult =
  | { kind: "ready"; snapshot: SharedBrowserHostSnapshot }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

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

/**
 * Waits until Instafy's browser on the space's machine is ready, starting it
 * when it is idle or has failed and the person may control the browser.
 *
 * | state                            | action                                   |
 * |----------------------------------|------------------------------------------|
 * | ready                            | done                                     |
 * | idle, failed                     | start (control) or ask a builder (view)  |
 * | starting, stopping, unknown      | poll again                               |
 * | poisoned                         | error: the machine must restart          |
 *
 * A start refused with `browser_host_stopping` is asked again after a second.
 * Gateway errors (502, 503, 504) and token failures are polled through; the
 * whole wait is capped.
 */
export async function waitForSharedBrowserHostReady(params: {
  projectId: string;
  runtimeId: string;
  browserSessionId: string;
  canControl: boolean;
  client: SharedBrowserHostClient;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  stoppingRetryMs?: number;
  now?: () => number;
  sleep?: Sleep;
}): Promise<SharedBrowserHostWaitResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? sleepUnlessAborted;
  const pollMs = params.pollMs ?? SHARED_BROWSER_HOST_POLL_MS;
  const stoppingRetryMs = params.stoppingRetryMs ?? SHARED_BROWSER_HOST_STOPPING_RETRY_MS;
  const deadline = now() + (params.timeoutMs ?? SHARED_BROWSER_HOST_WAIT_TIMEOUT_MS);
  const request: SharedBrowserHostRequest = {
    projectId: params.projectId,
    runtimeId: params.runtimeId,
    browserSessionId: params.browserSessionId,
    signal: params.signal,
  };
  let startRequests = 0;
  const cancelled = () => params.signal?.aborted === true;
  const pause = async (ms: number): Promise<boolean> => {
    const remaining = deadline - now();
    if (remaining <= 0) return true;
    return sleep(Math.min(ms, remaining), params.signal);
  };

  while (!cancelled() && now() < deadline) {
    let snapshot: SharedBrowserHostSnapshot | null;
    try {
      snapshot = await params.client.fetchHost(request);
    } catch (error) {
      if (cancelled()) break;
      if (params.client.isUnavailableError(error) || isTokenError(error)) {
        if (!(await pause(pollMs))) break;
        continue;
      }
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    if (cancelled()) break;
    if (!snapshot) {
      return { kind: "error", message: SHARED_BROWSER_HOST_COPY.notAvailable };
    }
    if (snapshot.state === "ready") {
      return { kind: "ready", snapshot };
    }
    if (snapshot.state === "poisoned") {
      return { kind: "error", message: SHARED_BROWSER_HOST_COPY.poisoned };
    }
    if (snapshot.state === "idle" || snapshot.state === "failed") {
      if (!params.canControl) {
        return { kind: "error", message: SHARED_BROWSER_HOST_COPY.askBuilder };
      }
      // A failure after a start asked for here is this wait's answer.
      if (snapshot.state === "failed" && startRequests > 0) {
        return { kind: "error", message: SHARED_BROWSER_HOST_COPY.didNotStart };
      }
      if (startRequests >= SHARED_BROWSER_HOST_MAX_START_REQUESTS) {
        return { kind: "error", message: SHARED_BROWSER_HOST_COPY.didNotStart };
      }
      startRequests += 1;
      try {
        const started = await params.client.startHost(request);
        if (cancelled()) break;
        if (started?.state === "ready") {
          return { kind: "ready", snapshot: started };
        }
      } catch (error) {
        if (cancelled()) break;
        if (params.client.isHostRefusedError(error)) {
          const code = (error as { code?: unknown }).code;
          if (code === "browser_host_stopping") {
            if (!(await pause(stoppingRetryMs))) break;
            continue;
          }
          if (code === "browser_host_poisoned") {
            return { kind: "error", message: SHARED_BROWSER_HOST_COPY.poisoned };
          }
          if (code === "machine_stopping") {
            return { kind: "error", message: SHARED_BROWSER_HOST_COPY.machineStopping };
          }
          return { kind: "error", message: SHARED_BROWSER_HOST_COPY.didNotStart };
        }
        if (!params.client.isUnavailableError(error) && !isTokenError(error)) {
          return { kind: "error", message: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    // starting, stopping, unknown, or a start just asked for.
    if (!(await pause(pollMs))) break;
  }
  if (cancelled()) {
    return { kind: "cancelled" };
  }
  return { kind: "error", message: SHARED_BROWSER_HOST_COPY.didNotStart };
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
  | { kind: "error"; message: string }
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
  if (!ensured) return { kind: "error", message: SHARED_BROWSER_HOST_COPY.machineDidNotStart };

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
  return { kind: "error", message: SHARED_BROWSER_HOST_COPY.machineDidNotStart };
}
