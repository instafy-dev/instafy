function buildDesktopRuntimeBaseUrl(controllerUrl: string, projectId: string): string {
  const base = controllerUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("Desktop runtime controller URL is unavailable.");
  }
  return `${base}/projects/${encodeURIComponent(projectId)}/runtime`;
}

export class DesktopRuntimeHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Controller returned HTTP ${status}.`);
    this.name = "DesktopRuntimeHttpError";
    this.status = status;
  }
}

export type DesktopRuntimeControllerCredentialMode = "ambient" | "fixed";

export type DesktopRuntimeControllerCredentialProvenance =
  | { kind: "fixed" }
  | { kind: "ambient"; userId: string };

export type DesktopRuntimeControllerCredentialAction =
  | "replace"
  | "reuse"
  | "rotate";

/**
 * Decide whether a renderer-verified controller credential may keep the
 * existing runtime process. Ambient rotation is allowed only inside the exact
 * controller and user binding; fixed credentials remain exact pairs.
 */
export function resolveDesktopRuntimeControllerCredentialAction(options: {
  currentControllerUrl: string;
  currentCredentialProvenance: DesktopRuntimeControllerCredentialProvenance;
  currentAccessToken: string;
  requestedControllerUrl: string;
  requestedCredentialProvenance: DesktopRuntimeControllerCredentialProvenance;
  requestedAccessToken: string;
}): DesktopRuntimeControllerCredentialAction {
  const currentProvenance = options.currentCredentialProvenance;
  const requestedProvenance = options.requestedCredentialProvenance;
  if (
    options.currentControllerUrl !== options.requestedControllerUrl ||
    currentProvenance.kind !== requestedProvenance.kind
  ) {
    return "replace";
  }
  if (currentProvenance.kind === "fixed" || requestedProvenance.kind === "fixed") {
    return options.currentAccessToken === options.requestedAccessToken
      ? "reuse"
      : "replace";
  }
  if (currentProvenance.userId !== requestedProvenance.userId) {
    return "replace";
  }
  return options.currentAccessToken === options.requestedAccessToken
    ? "reuse"
    : "rotate";
}

export function resolveRefreshedDesktopRuntimeAccessToken(
  provenance: DesktopRuntimeControllerCredentialProvenance,
  session: { accessToken: string; userId: string },
): string | null {
  const accessToken = session.accessToken.trim();
  const userId = session.userId.trim();
  if (
    provenance.kind !== "ambient" ||
    !accessToken ||
    !userId ||
    provenance.userId !== userId
  ) {
    return null;
  }
  return accessToken;
}

function requireDesktopRuntimeAccessToken(getAccessToken: () => string | undefined): string {
  const token = getAccessToken()?.trim();
  if (!token) {
    throw new Error("Desktop runtime controller access is unavailable.");
  }
  return token;
}

/**
 * Retry one authenticated controller request only when its retained
 * provenance permits refreshing the visible renderer session. Long-running
 * local jobs can outlive the JWT that launched them, while fixed controller
 * pairs must keep using the exact token that launched them.
 */
export async function withRefreshedDesktopRuntimeAccess<T>(options: {
  credentialProvenance: DesktopRuntimeControllerCredentialProvenance;
  getAccessToken: () => string | undefined;
  refreshAccessToken: () => Promise<void>;
  request: (accessToken: string) => Promise<T>;
}): Promise<T> {
  const firstToken = requireDesktopRuntimeAccessToken(options.getAccessToken);
  try {
    return await options.request(firstToken);
  } catch (error) {
    if (
      !(error instanceof DesktopRuntimeHttpError) ||
      (error.status !== 401 && error.status !== 403)
    ) {
      throw error;
    }
    if (options.credentialProvenance.kind !== "ambient") {
      throw error;
    }
  }

  await options.refreshAccessToken();
  return await options.request(requireDesktopRuntimeAccessToken(options.getAccessToken));
}

export async function withDesktopRuntimeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * ChildProcess `events.once(..., "exit")` rejects when the process emits an
 * `error`. That is still a terminal observation requiring the same serialized
 * tree cleanup as a normal exit; callers may use the error only for logging.
 */
export async function runDesktopRuntimeExitCleanup<T>(
  exited: Promise<T>,
  cleanup: (exitError: unknown | null) => Promise<void>,
): Promise<void> {
  let exitError: unknown | null = null;
  try {
    await exited;
  } catch (error) {
    exitError = error;
  }
  await cleanup(exitError);
}

export type DesktopQuitWaitAction = "force" | "cancel";

export function canResumeDesktopRuntimeAfterFailedQuit(options: {
  localStopAttempted: boolean;
  runtimeRootAlive: boolean;
}): boolean {
  return !options.localStopAttempted && options.runtimeRootAlive;
}

export function createDesktopQuitWaitControl(): {
  promise: Promise<DesktopQuitWaitAction>;
  choose: (action: DesktopQuitWaitAction) => boolean;
  isSettled: () => boolean;
} {
  let settled = false;
  let resolveAction!: (action: DesktopQuitWaitAction) => void;
  const promise = new Promise<DesktopQuitWaitAction>((resolve) => {
    resolveAction = resolve;
  });
  return {
    promise,
    choose(action) {
      if (settled) {
        return false;
      }
      settled = true;
      resolveAction(action);
      return true;
    },
    isSettled: () => settled,
  };
}

export function buildDesktopRuntimeStopUrl(controllerUrl: string): string {
  const base = controllerUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("Desktop runtime controller URL is unavailable.");
  }
  return `${base}/runtime/stop`;
}

export function buildDesktopRuntimeDrainUrl(
  controllerUrl: string,
  projectId: string,
  runtimeId: string,
): string {
  return `${buildDesktopRuntimeBaseUrl(controllerUrl, projectId)}/${encodeURIComponent(runtimeId)}/drain`;
}

export function buildDesktopRuntimeResumeUrl(
  controllerUrl: string,
  projectId: string,
  runtimeId: string,
): string {
  return buildDesktopRuntimeDrainUrl(controllerUrl, projectId, runtimeId).replace(
    /\/drain$/,
    "/resume",
  );
}

export function readDesktopRuntimeActiveJobCount(
  payload: unknown,
  runtimeId: string,
  nowMs: number = Date.now(),
): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Controller returned an invalid runtime status response.");
  }
  const runtime = payload as {
    ok?: unknown;
    contractVersion?: unknown;
    runtimeId?: unknown;
    status?: unknown;
    activeJobCount?: unknown;
    drainExpiresAt?: unknown;
  };
  const drainExpiryMs =
    typeof runtime.drainExpiresAt === "string"
      ? Date.parse(runtime.drainExpiresAt)
      : Number.NaN;
  if (
    runtime.ok !== true ||
    runtime.contractVersion !== 1 ||
    runtime.status !== "draining" ||
    !Number.isFinite(drainExpiryMs) ||
    drainExpiryMs - nowMs < 15_000
  ) {
    throw new Error("Controller did not confirm the desktop runtime drain fence.");
  }
  if (runtime.runtimeId !== runtimeId) {
    throw new Error("The active desktop runtime was not present in controller status.");
  }
  const value = runtime.activeJobCount;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Controller runtime status did not include a valid active job count.");
  }
  return value;
}

export function assertDesktopRuntimeResumed(payload: unknown, runtimeId: string): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Controller returned an invalid runtime resume response.");
  }
  const runtime = payload as {
    ok?: unknown;
    contractVersion?: unknown;
    runtimeId?: unknown;
    status?: unknown;
    drainExpiresAt?: unknown;
  };
  if (
    runtime.ok !== true ||
    runtime.contractVersion !== 1 ||
    runtime.runtimeId !== runtimeId ||
    runtime.status !== "ready" ||
    runtime.drainExpiresAt !== null
  ) {
    throw new Error("Controller did not confirm that the desktop runtime resumed.");
  }
}
