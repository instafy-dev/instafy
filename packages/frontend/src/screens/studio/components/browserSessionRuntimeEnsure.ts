import type {
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController";
import { runtimeEntryIsDispatchable } from "../../../runtime/utils/runtimeEntry";

const BROWSER_RUNTIME_ENSURE_GRACE_MS = 15_000;
const GENERIC_HOSTED_RUNTIME_DISPLAY_NAME = "hosted runtime";
const BROWSER_RUNTIME_ORIGIN_POLL_INITIAL_MS = 500;
const BROWSER_RUNTIME_ORIGIN_POLL_MAX_MS = 4_000;
const BROWSER_RUNTIME_ORIGIN_TIMEOUT_MS = 120_000;

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

export interface BrowserRuntimeCandidate {
  runtimeId: string;
  originId: string;
  endpoint: string | null;
}

export function resolveBrowserRuntimeCandidate(
  entries: ControllerRuntimeStatusEntry[],
  preferRuntimeId: string | null,
): BrowserRuntimeCandidate | null {
  const usable = entries.filter(
    (entry) =>
      isManagedInstafyCloudProvider(entry.provider) &&
      entry.isPrivateSelfHosted !== true &&
      runtimeEntryIsDispatchable(entry) &&
      runtimeEntryHasOriginId(entry),
  );
  const preferred =
    preferRuntimeId && preferRuntimeId.trim().length > 0
      ? usable.find(
          (entry) =>
            entry.runtimeId === preferRuntimeId.trim() &&
            runtimeNameLooksBrowserCapable(entry.displayName),
        ) ?? null
      : null;
  if (preferred) {
    return {
      runtimeId: preferred.runtimeId,
      originId: preferred.origin?.originId?.trim() ?? "",
      endpoint: runtimeEntryOriginEndpoint(preferred),
    };
  }
  const named =
    usable.find((entry) => runtimeNameLooksBrowserCapable(entry.displayName)) ?? null;
  if (!named) {
    return null;
  }
  return {
    runtimeId: named.runtimeId,
    originId: named.origin?.originId?.trim() ?? "",
    endpoint: runtimeEntryOriginEndpoint(named),
  };
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
  const deadline = Date.now() + timeoutMs;
  let pollIntervalMs = initialPollIntervalMs;

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
    if (originId) {
      return {
        originId,
        endpoint: runtimeOriginEndpoint(entry),
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const completedDelay = await waitForPollDelay(
      Math.min(pollIntervalMs, remainingMs),
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
