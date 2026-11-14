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
  cleanup: (exitError: unknown | null, exit: T | null) => Promise<void>,
): Promise<void> {
  let exitError: unknown | null = null;
  let exit: T | null = null;
  try {
    exit = await exited;
  } catch (error) {
    exitError = error;
  }
  await cleanup(exitError, exit);
}

/**
 * The exit status runtime-agent uses when it stopped because the controller
 * refused it for a deleted space (`SPACE_DELETED_EXIT_CODE` in
 * packages/runtime-agent/src/agent.rs).
 */
export const DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE = 3;

/** Whether the runtime process exited because its space was deleted. */
export function desktopRuntimeExitedForDeletedSpace(
  exit: { code: number | null } | null,
): boolean {
  return exit?.code === DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE;
}

/**
 * The user a runtime start's launch grants are resolved for (4.3): the
 * visible session's user when the start is bound to it. A Personal Browser
 * runtime never offers a local engine, so its starts are granted nothing.
 */
export function resolveDesktopRuntimeLaunchGrantUserId(options: {
  enablePersonalBrowser: boolean;
  boundUserId: string | null;
}): string | null {
  return options.enablePersonalBrowser ? null : options.boundUserId;
}

/**
 * What a consent change's replacement starts from (4.3): the replaced
 * runtime's own options, with the token of the session the Studio window
 * shows now when that session is the user the runtime was bound to. A token
 * read before the consent sheet and the fence may have expired since; one
 * from any other session never starts it. Without a usable session, the
 * retained token stays, which a fence's 401 may just have refreshed.
 */
export function buildConsentChangeRestartOptions<T extends { controllerAccessToken?: string }>(
  options: {
    restartOptions: T;
    launchGrantUserId: string | null;
    currentSession: { accessToken: string; userId: string } | null;
  },
): T {
  const boundUserId = options.launchGrantUserId?.trim().toLowerCase() ?? "";
  const accessToken = options.currentSession?.accessToken.trim() ?? "";
  const userId = options.currentSession?.userId.trim().toLowerCase() ?? "";
  if (!boundUserId || !accessToken || userId !== boundUserId) {
    return { ...options.restartOptions };
  }
  return { ...options.restartOptions, controllerAccessToken: accessToken };
}

export type DesktopRuntimeReplacementDecision = "replace" | "keep";

/**
 * Decide whether Desktop may replace its runtime. A runtime started with a
 * launch grant, or one a consent change replaces, is fenced first and its
 * active jobs counted. Busy, or a count that could not be read, means asking
 * the person; keeping the work resumes the runtime. Any other replacement goes
 * ahead as it always has, without a fence.
 */
export async function confirmDesktopRuntimeReplacement(options: {
  previousHeldLaunchGrant: boolean;
  consentChange: boolean;
  fence: () => Promise<number>;
  /** True when the person chose to stop the work and continue. */
  ask: (activeJobCount: number | null) => Promise<boolean>;
  resume: () => Promise<void>;
  onError?: (stage: "fence" | "resume", error: unknown) => void;
}): Promise<DesktopRuntimeReplacementDecision> {
  if (!options.previousHeldLaunchGrant && !options.consentChange) {
    return "replace";
  }
  let activeJobCount: number | null;
  try {
    activeJobCount = await options.fence();
  } catch (error) {
    options.onError?.("fence", error);
    activeJobCount = null;
  }
  if (activeJobCount === 0) {
    return "replace";
  }
  if (await options.ask(activeJobCount)) {
    return "replace";
  }
  try {
    await options.resume();
  } catch (error) {
    options.onError?.("resume", error);
  }
  return "keep";
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
