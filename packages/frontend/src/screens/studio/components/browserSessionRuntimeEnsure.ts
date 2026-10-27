import type {
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController";
import { runtimeEntryIsDispatchable, runtimeEntryIsExpired } from "../../../runtime/utils/runtimeEntry";

const BROWSER_RUNTIME_ENSURE_GRACE_MS = 15_000;
const GENERIC_HOSTED_RUNTIME_DISPLAY_NAME = "hosted runtime";
const BROWSER_RUNTIME_ORIGIN_POLL_INITIAL_MS = 500;
const BROWSER_RUNTIME_ORIGIN_POLL_MAX_MS = 4_000;
/**
 * How long a press waits for the browser session machine it ensured to
 * answer: as long as the cold path waits for the space's own machine
 * (SPACE_MACHINE_COLD_START_TIMEOUT_MS), because a relaunch of either can
 * take minutes.
 */
export const BROWSER_RUNTIME_ORIGIN_TIMEOUT_MS = 10 * 60_000;
/** After this long the wait says the machine is still starting, and reads less often. */
export const BROWSER_RUNTIME_ORIGIN_SLOW_AFTER_MS = 60_000;
const BROWSER_RUNTIME_ORIGIN_SLOW_POLL_MS = 10_000;
/** Statuses of a machine that has stopped, or is stopping, with nothing starting it. */
const ENDED_BROWSER_RUNTIME_STATUSES = new Set([
  "stopped",
  "stopping",
  "offline",
  "error",
  "failed",
  "terminated",
  "expired",
  "deleted",
  "removed",
]);

function normalizedProviderKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isManagedInstafyCloudProvider(
  provider: string | null | undefined,
): boolean {
  const key = normalizedProviderKey(provider);
  return key === "instafy_cloud";
}

function runtimeEntryHasOriginId(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): boolean {
  const originId = entry?.origin?.originId;
  return typeof originId === "string" && originId.trim().length > 0;
}

function runtimeEntryOriginEndpoint(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): string | null {
  const endpoint = entry?.origin?.endpoint;
  if (typeof endpoint !== "string") {
    return null;
  }
  const trimmed = endpoint.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function runtimeNameLooksBrowserCapable(
  displayName: string | null | undefined,
): boolean {
  const normalized = (displayName ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("browser session") ||
    normalized.includes("webdev") ||
    normalized.includes("playwright")
  );
}

/**
 * A Shared Browser Studio can open:
 * - `lazy`: Instafy's browser on the space's own machine, which the machine
 *   starts on demand (the controller reports `sharedBrowserHost`);
 * - `session`: a separate browser session machine (found by its name).
 */
export type BrowserRuntimeCandidateMode = "lazy" | "session";

export interface BrowserRuntimeCandidate {
  runtimeId: string;
  originId: string;
  endpoint: string | null;
  mode: BrowserRuntimeCandidateMode;
}

/** A separate browser session machine, by the name Studio gives it. */
export function runtimeEntryLooksLikeBrowserSession(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): boolean {
  return runtimeNameLooksBrowserCapable(entry?.displayName);
}

/** The space's own machine reports Instafy's browser on demand. */
export function runtimeEntryIsLazyBrowserHost(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): boolean {
  return entry?.sharedBrowserHost?.version === 1 && entry.sharedBrowserHost.mode === "lazy";
}

function runtimeEntryIsLiveManagedBrowserMachine(entry: ControllerRuntimeStatusEntry): boolean {
  return isManagedInstafyCloudProvider(entry.provider) &&
    entry.isPrivateSelfHosted !== true &&
    runtimeEntryIsDispatchable(entry) &&
    runtimeEntryHasOriginId(entry);
}

export function listBrowserRuntimeCandidates(
  entries: ControllerRuntimeStatusEntry[],
): BrowserRuntimeCandidate[] {
  const candidates: BrowserRuntimeCandidate[] = [];
  for (const entry of entries) {
    if (!runtimeEntryIsLiveManagedBrowserMachine(entry)) continue;
    const mode: BrowserRuntimeCandidateMode | null = runtimeEntryIsLazyBrowserHost(entry)
      ? "lazy"
      : runtimeNameLooksBrowserCapable(entry.displayName)
        ? "session"
        : null;
    if (!mode) continue;
    candidates.push({
      runtimeId: entry.runtimeId,
      originId: entry.origin!.originId!.trim(),
      endpoint: runtimeEntryOriginEndpoint(entry),
      mode,
    });
  }
  return candidates;
}

/** Only separate browser session machines, never the space's own machine. */
export function listBrowserSessionCandidates(
  entries: ControllerRuntimeStatusEntry[],
): BrowserRuntimeCandidate[] {
  return listBrowserRuntimeCandidates(entries).filter((candidate) => candidate.mode === "session");
}

export type BrowserRuntimeSelection =
  | { kind: "selected"; candidate: BrowserRuntimeCandidate }
  | { kind: "missing"; runtimeId: string; candidates: BrowserRuntimeCandidate[] }
  | { kind: "choose"; candidates: BrowserRuntimeCandidate[] }
  | { kind: "new"; candidates: BrowserRuntimeCandidate[] };

export function resolveBrowserRuntimeSelection(
  entries: ControllerRuntimeStatusEntry[],
  exactRuntimeId: string | null,
): BrowserRuntimeSelection {
  const candidates = listBrowserRuntimeCandidates(entries);
  if (exactRuntimeId) {
    const candidate = candidates.find((item) => item.runtimeId === exactRuntimeId);
    return candidate ? { kind: "selected", candidate } : { kind: "missing", runtimeId: exactRuntimeId, candidates };
  }
  if (candidates.length === 1) return { kind: "selected", candidate: candidates[0]! };
  return { kind: candidates.length ? "choose" : "new", candidates };
}

export function resolveBrowserRuntimeCandidate(
  entries: ControllerRuntimeStatusEntry[],
  preferRuntimeId: string | null,
): BrowserRuntimeCandidate | null {
  const preferred = listBrowserRuntimeCandidates(entries).find((item) => item.runtimeId === preferRuntimeId?.trim());
  const selection = resolveBrowserRuntimeSelection(entries, preferred?.runtimeId ?? null);
  return selection.kind === "selected" ? selection.candidate : null;
}

export interface BrowserRuntimeProjectStatusSnapshot {
  projectId: string | null;
  runtimes: readonly ControllerRuntimeStatusEntry[];
}

export interface ResolveAutoRecyclableBrowserRuntimeInput {
  activeProjectId: string | null;
  blockerProjectId: string | null;
  blockerRuntimeId: string | null;
  blockerRuntimeLabel: string | null;
  projectStatusSnapshot: BrowserRuntimeProjectStatusSnapshot | null;
}

export interface AutoRecyclableBrowserRuntimeIdentity {
  runtimeId: string;
  projectId: string;
  provider: string;
  displayName: string;
}

function normalizeIdentifier(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function resolveAutoRecyclableBrowserRuntimeIdentity(
  input: ResolveAutoRecyclableBrowserRuntimeInput,
): AutoRecyclableBrowserRuntimeIdentity | null {
  const activeProjectId = normalizeIdentifier(input.activeProjectId);
  const blockerProjectId = normalizeIdentifier(input.blockerProjectId);
  const blockerRuntimeId = normalizeIdentifier(input.blockerRuntimeId);
  const blockerRuntimeLabel = normalizeIdentifier(input.blockerRuntimeLabel);
  const snapshotProjectId = normalizeIdentifier(
    input.projectStatusSnapshot?.projectId,
  );
  if (
    !activeProjectId ||
    !blockerProjectId ||
    !blockerRuntimeId ||
    blockerRuntimeLabel.toLowerCase() !== GENERIC_HOSTED_RUNTIME_DISPLAY_NAME ||
    activeProjectId !== blockerProjectId ||
    activeProjectId !== snapshotProjectId
  ) {
    return null;
  }

  const blockerEntry = input.projectStatusSnapshot?.runtimes.find(
    (entry) => normalizeIdentifier(entry.runtimeId) === blockerRuntimeId,
  );
  if (!blockerEntry) {
    return null;
  }

  const provider = blockerEntry.provider.trim();
  const normalizedProvider = provider.toLowerCase();
  const displayName = blockerEntry.displayName?.trim() ?? "";
  if (
    blockerEntry.isLocal !== false ||
    (normalizedProvider !== "instafy-cloud" &&
      normalizedProvider !== "instafy_cloud") ||
    displayName.toLowerCase() !== blockerRuntimeLabel.toLowerCase()
  ) {
    return null;
  }

  // A generic runtime can consume the organization's only hosted slot while it
  // is still requested/starting, or while its heartbeat-derived health is
  // briefly stale. Do not require the frontend snapshot to call it dispatchable:
  // stopIfIdle performs the authoritative identity and active-job checks under
  // the controller's runtime lock before releasing anything.

  return {
    runtimeId: blockerRuntimeId,
    projectId: activeProjectId,
    provider,
    displayName,
  };
}

export function resolveAutoRecyclableBrowserRuntimeId(
  input: ResolveAutoRecyclableBrowserRuntimeInput,
): string | null {
  return resolveAutoRecyclableBrowserRuntimeIdentity(input)?.runtimeId ?? null;
}

type BrowserRuntimeStatusFetcher = (
  params: FetchRuntimeStatusParams,
) => Promise<FetchRuntimeStatusResult | null>;

export interface WaitForBrowserRuntimeOriginParams {
  projectId: string;
  runtimeId: string;
  fetchStatus: BrowserRuntimeStatusFetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
  initialPollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Called once when the machine has not answered within the first minute. */
  onSlow?: () => void;
  /**
   * Asks the controller for the machine again. Called at most once, when the
   * machine has been silent past its idle time: the controller replaces such
   * a generation (a stale heartbeat alone is not enough for it, so a press
   * that came earlier was given the silent one back).
   */
  ensureAgain?: () => Promise<unknown>;
}

export interface BrowserRuntimeOriginResult {
  originId: string | null;
  endpoint: string | null;
}

function runtimeOriginEndpoint(
  entry: ControllerRuntimeStatusEntry | null | undefined,
): string | null {
  const endpoint = entry?.origin?.endpoint;
  if (typeof endpoint !== "string") {
    return null;
  }
  const trimmed = endpoint.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function waitForPollDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) {
        return;
      }
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

/**
 * Waits, after a press ensured a browser session machine, until that machine
 * answers: it is dispatchable (a fresh heartbeat) and lists its origin. An
 * origin listed for a machine that does not answer (its runtime started
 * again, or the controller has not replaced a silent generation yet) is
 * never used: connecting to it can only fail. The wait lasts while the
 * machine may still come up, up to BROWSER_RUNTIME_ORIGIN_TIMEOUT_MS:
 *
 * - two reads in a row that show it stopped or gone, with nothing starting
 *   it, end the wait at once;
 * - once it has been silent past its idle time, the controller is asked for
 *   it again (`ensureAgain`, once), which replaces that generation;
 * - after the first minute `onSlow` is called once and status is read every
 *   10 s.
 */
export async function waitForBrowserRuntimeOrigin(
  params: WaitForBrowserRuntimeOriginParams,
): Promise<BrowserRuntimeOriginResult> {
  const timeoutMs = Math.max(0, params.timeoutMs ?? BROWSER_RUNTIME_ORIGIN_TIMEOUT_MS);
  const initialPollIntervalMs = Math.max(
    1,
    params.initialPollIntervalMs ?? BROWSER_RUNTIME_ORIGIN_POLL_INITIAL_MS,
  );
  const maxPollIntervalMs = Math.max(
    initialPollIntervalMs,
    params.maxPollIntervalMs ?? BROWSER_RUNTIME_ORIGIN_POLL_MAX_MS,
  );
  const startedAtMs = Date.now();
  const deadline = startedAtMs + timeoutMs;
  let pollIntervalMs = initialPollIntervalMs;
  let endedReads = 0;
  let ensuredAgain = false;
  let slowReported = false;

  while (Date.now() < deadline && !params.signal?.aborted) {
    const status = await params.fetchStatus({
      projectId: params.projectId,
      signal: params.signal,
      quietOnAbort: true,
    });
    if (params.signal?.aborted) {
      break;
    }
    const entry =
      status?.runtimes?.find(
        (candidate) => candidate.runtimeId === params.runtimeId,
      ) ?? null;
    const originId =
      typeof entry?.origin?.originId === "string"
        ? entry.origin.originId.trim()
        : "";
    if (originId && runtimeEntryIsDispatchable(entry)) {
      return {
        originId,
        endpoint: runtimeOriginEndpoint(entry),
      };
    }
    if (Array.isArray(status?.runtimes)) {
      const ended = !entry || ENDED_BROWSER_RUNTIME_STATUSES.has((entry.status ?? "").trim().toLowerCase());
      endedReads = ended ? endedReads + 1 : 0;
      if (endedReads >= 2) {
        break;
      }
    }
    if (entry && !ensuredAgain && params.ensureAgain && runtimeEntryIsExpired(entry)) {
      ensuredAgain = true;
      // Its answer does not matter: the reads that follow show the new launch.
      void params.ensureAgain().catch(() => undefined);
    }

    const slow = Date.now() - startedAtMs >= BROWSER_RUNTIME_ORIGIN_SLOW_AFTER_MS;
    if (slow && !slowReported) {
      slowReported = true;
      params.onSlow?.();
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const completedDelay = await waitForPollDelay(
      Math.min(slow ? Math.max(pollIntervalMs, BROWSER_RUNTIME_ORIGIN_SLOW_POLL_MS) : pollIntervalMs, remainingMs),
      params.signal,
    );
    if (!completedDelay) {
      break;
    }
    pollIntervalMs = Math.min(maxPollIntervalMs, pollIntervalMs * 2);
  }

  return {
    originId: null,
    endpoint: null,
  };
}

type BrowserRuntimeEnsureRequest = {
  promise: Promise<unknown>;
  resolved: boolean;
};
type BrowserRuntimeEnsureOptions = {
  graceMs?: number;
  reuseResolved?: boolean;
};
const browserRuntimeEnsureRequests = new Map<string, BrowserRuntimeEnsureRequest>();

export function coalesceBrowserRuntimeEnsure<T>(
  key: string,
  operation: () => Promise<T>,
  options: BrowserRuntimeEnsureOptions = {},
): Promise<T> {
  const graceMs = options.graceMs ?? BROWSER_RUNTIME_ENSURE_GRACE_MS;
  const existing = browserRuntimeEnsureRequests.get(key) as BrowserRuntimeEnsureRequest | undefined;
  if (existing) {
    if (!existing.resolved || options.reuseResolved !== false) {
      return existing.promise as Promise<T>;
    }
    browserRuntimeEnsureRequests.delete(key);
  }

  const request = operation();
  const entry: BrowserRuntimeEnsureRequest = {
    promise: request,
    resolved: false,
  };
  browserRuntimeEnsureRequests.set(key, entry);
  void request.then(
    () => {
      entry.resolved = true;
      globalThis.setTimeout(() => {
        if (browserRuntimeEnsureRequests.get(key) === entry) {
          browserRuntimeEnsureRequests.delete(key);
        }
      }, graceMs);
    },
    () => {
      if (browserRuntimeEnsureRequests.get(key) === entry) {
        browserRuntimeEnsureRequests.delete(key);
      }
    },
  );
  return request;
}
