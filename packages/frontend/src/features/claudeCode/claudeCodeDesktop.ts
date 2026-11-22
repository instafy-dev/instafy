/**
 * Instafy Desktop's Claude Code module (docs/Local-Engine-Turns.md 4.1,
 * DA/claudeCode), reached through Desktop's existing extension-invoke API
 * under the extension id Desktop registers it with. Studio reads only what
 * the module says about this computer; Desktop keeps the consent record and
 * the grant to itself.
 */
export const CLAUDE_CODE_DESKTOP_EXTENSION_ID = "claude-code";

export interface ClaudeCodeDesktopStatus {
  /** True only where Desktop offers Claude Code turns (macOS in v1). */
  supported: boolean;
  found: boolean;
  /**
   * While it is on, the binary its turns use; otherwise the one Find or
   * Locate turned up. Shown only on this computer and never sent anywhere.
   */
  path: string | null;
  /**
   * This Instafy account turned Claude Code on for this computer: at least
   * one of its logins has consent of the current version here.
   */
  consented: boolean;
  /**
   * This account's logins set up on this computer, each with its folder here
   * (docs/Local-Engine-Turns.md 11.19). Empty while it is off, and from a
   * Desktop older than logins.
   */
  logins: readonly ClaudeCodeDesktopLogin[];
  /** Why Desktop won't use the path it has (DA/claudeCode/validate.ts), or null. */
  problem?: ClaudeCodeDesktopProblem | null;
  /**
   * While it is on: another binary Find or Locate turned up, or the binary in
   * use itself (equal to `path`, with no `candidateProblem`) when Find read
   * login-shell values for it that Desktop can use in place of recorded ones
   * it no longer can (D26). Turns keep the binary and values in use until Use
   * Claude Code on this computer confirms this one.
   */
  candidatePath?: string | null;
  /** While it is on: why Desktop won't use `candidatePath`, or that Find found nothing. */
  candidateProblem?: ClaudeCodeDesktopProblem | null;
  /**
   * The login-shell setting a `shell_setting_unusable` problem is about:
   * `problem`'s when it is one, otherwise `candidateProblem`'s. Never its value.
   */
  shellSetting?: ClaudeCodeShellSetting | null;
}

/**
 * One of this account's Claude Code logins as this computer's Desktop has it
 * (11.19): which folder on this computer is that login. The folder shows only
 * on this computer and is never sent anywhere.
 */
export interface ClaudeCodeDesktopLogin {
  /** The login's id, as the controller lists it: a lowercase UUID. */
  id: string;
  /** Its folder here, a full path; null for Claude Code's usual folder. */
  folder: string | null;
  /** Why the folder no longer passes Desktop's checks, when it doesn't. */
  problem?: ClaudeCodeDesktopProblem;
}

/** Why Desktop won't use a `claude` it found or was shown, or the login-shell values with it (4.1, D26). */
export type ClaudeCodeDesktopProblem =
  | "not_found"
  | "relative_path"
  | "missing"
  | "not_a_file"
  | "not_executable"
  | "foreign_owner"
  | "writable_by_others"
  | "inside_instafy_folder"
  | "too_many_links"
  | "shell_setting_unusable";

/** The login-shell settings that name a place on disk, which Desktop checks as runtime-agent does (D26). */
export type ClaudeCodeShellSetting = "CLAUDE_CONFIG_DIR" | "NODE_EXTRA_CA_CERTS";

const DESKTOP_PROBLEMS: ReadonlySet<string> = new Set<ClaudeCodeDesktopProblem>([
  "not_found",
  "relative_path",
  "missing",
  "not_a_file",
  "not_executable",
  "foreign_owner",
  "writable_by_others",
  "inside_instafy_folder",
  "too_many_links",
  "shell_setting_unusable",
]);

const SHELL_SETTINGS: ReadonlySet<string> = new Set<ClaudeCodeShellSetting>([
  "CLAUDE_CONFIG_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

const MAX_DESKTOP_PATH_LENGTH = 4096;

function desktopPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DESKTOP_PATH_LENGTH
    ? value
    : null;
}

function desktopProblem(value: unknown): ClaudeCodeDesktopProblem | null {
  return typeof value === "string" && DESKTOP_PROBLEMS.has(value) ? (value as ClaudeCodeDesktopProblem) : null;
}

const LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most logins a computer has set up (runtime-contracts' MAX_LOGINS). */
const MAX_DESKTOP_LOGINS = 10;

/** Whether `value` is a login's id as Desktop and the controller take one: a UUID. */
export function isClaudeCodeLoginId(value: unknown): value is string {
  return typeof value === "string" && LOGIN_ID.test(value);
}

/**
 * `logins` of the module's answer: well-formed entries only, each id once
 * and at most ten. A folder is a full path or null; anything else drops the
 * entry, as it says nothing Studio could show.
 */
function desktopLogins(value: unknown): ClaudeCodeDesktopLogin[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const logins: ClaudeCodeDesktopLogin[] = [];
  for (const entry of value) {
    if (logins.length === MAX_DESKTOP_LOGINS) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (!isClaudeCodeLoginId(record.id)) {
      continue;
    }
    const id = record.id.toLowerCase();
    const folder = record.folder === null ? null : desktopPath(record.folder);
    if (seen.has(id) || (record.folder !== null && (!folder || !folder.startsWith("/")))) {
      continue;
    }
    seen.add(id);
    const problem = desktopProblem(record.problem);
    logins.push({ id, folder, ...(problem ? { problem } : {}) });
  }
  return logins;
}

/**
 * The module's answer, or null for anything but its shape. The optional
 * fields a Desktop adds are read when they hold what they should and left
 * out otherwise, so an older Desktop, which sends none of them, still works.
 */
export function parseClaudeCodeDesktopStatus(value: unknown): ClaudeCodeDesktopStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.supported !== "boolean" ||
    typeof record.found !== "boolean" ||
    typeof record.consented !== "boolean"
  ) {
    return null;
  }
  const problem = desktopProblem(record.problem);
  const candidatePath = desktopPath(record.candidatePath);
  const candidateProblem = desktopProblem(record.candidateProblem);
  const shellSetting =
    typeof record.shellSetting === "string" && SHELL_SETTINGS.has(record.shellSetting)
      ? (record.shellSetting as ClaudeCodeShellSetting)
      : null;
  return {
    supported: record.supported,
    found: record.found,
    path: desktopPath(record.path),
    consented: record.consented,
    logins: desktopLogins(record.logins),
    ...(problem ? { problem } : {}),
    ...(candidatePath ? { candidatePath } : {}),
    ...(candidateProblem ? { candidateProblem } : {}),
    ...(shellSetting ? { shellSetting } : {}),
  };
}

function desktopBridge() {
  return typeof window === "undefined" ? undefined : window.instafyDesktop;
}

// A Desktop that refused a `status` read once (one without the module
// refuses every time) is not asked for it again until the page loads again,
// so its main process does not log a refusal on every focus. Only `status`
// sets this or reads it: an action Desktop refuses is the person's to see
// ("Find the claude program on this computer first."), never a sign that the
// module is missing, and an action Desktop answers clears it.
let desktopModuleRefused = false;

export function forgetClaudeCodeDesktopRefusalForTests(): void {
  desktopModuleRefused = false;
}

/** Whether this page runs in Instafy Desktop, whose modules Studio can ask. */
export function claudeCodeDesktopHostAvailable(): boolean {
  return typeof desktopBridge()?.invokeDesktopExtension === "function";
}

/**
 * What this computer's Desktop says about Claude Code for this Instafy
 * account on this controller, or null when Studio is not in Desktop, or
 * Desktop has no such module or refused. Desktop keys the person's consent by
 * the controller Studio names (its own trust policy decides whether it
 * accepts it) and by the session it reads itself, never by anything else
 * Studio sends.
 */
export async function readClaudeCodeDesktopStatus(
  controllerUrl: string | null,
): Promise<ClaudeCodeDesktopStatus | null> {
  const bridge = desktopBridge();
  if (typeof bridge?.invokeDesktopExtension !== "function" || desktopModuleRefused) {
    return null;
  }
  const request: InstafyDesktopExtensionInvokeOptions = {
    extensionId: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
    method: "status",
    ...(controllerUrl ? { controllerUrl } : {}),
  };
  try {
    return parseClaudeCodeDesktopStatus(await bridge.invokeDesktopExtension(request));
  } catch {
    desktopModuleRefused = true;
    return null;
  }
}

/** What Your AI asks Desktop's module to do; each answers with the status after it. */
export type ClaudeCodeDesktopAction = "detect" | "locate" | "enable" | "disable" | "addLogin" | "removeLogin";

/**
 * Which login a consent is for (11.19). Studio passes only the login's id and
 * its name, never a path: Desktop shows the name, quoted, beside the folder
 * it checked itself.
 */
export type ClaudeCodeDesktopLoginConsent = { loginId: string; label: string };

/** Where another login's folder is: Claude Code's usual folder, or one the person picks in Desktop's native picker. */
export type ClaudeCodeDesktopFolderChoice = "usual" | "choose";

/**
 * What each action takes. `enable` with a login sets up the first login of a
 * computer with no record; without one, while Claude Code is on, it confirms
 * another program or new login-shell values and never adds a login.
 * `addLogin` sets up another login, and `removeLogin` removes one; removing
 * the last turns Claude Code off here, as `disable` does.
 */
export type ClaudeCodeDesktopActionPayload =
  | { action: "detect" | "locate" | "disable" }
  | { action: "enable"; login?: ClaudeCodeDesktopLoginConsent }
  | { action: "addLogin"; login: ClaudeCodeDesktopLoginConsent; folder: ClaudeCodeDesktopFolderChoice }
  | { action: "removeLogin"; loginId: string };

function desktopPayload(request: ClaudeCodeDesktopActionPayload): unknown {
  switch (request.action) {
    case "enable":
      return request.login ? { loginId: request.login.loginId, label: request.login.label } : undefined;
    case "addLogin":
      return { loginId: request.login.loginId, label: request.login.label, folder: request.folder };
    case "removeLogin":
      return { loginId: request.loginId };
    default:
      return undefined;
  }
}

/** Whether Desktop's answer lists the login as set up on this computer. */
export function claudeCodeLoginSetUpHere(status: ClaudeCodeDesktopStatus, loginId: string): boolean {
  const id = loginId.toLowerCase();
  return status.logins.some((login) => login.id === id);
}

/** A Desktop answer that refused the action, in Desktop's own words when it gave some. */
export class ClaudeCodeDesktopActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeDesktopActionError";
  }
}

// Electron wraps a refusal from the main process in the error's
// `toString()`: "Error invoking remote method 'instafy:desktopExtensionInvoke':
// Error: <Desktop's own words>", where "Error" is the error's name, which a
// Desktop error class may have set to its own ("...: SomethingError: ...").
const ELECTRON_INVOKE_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/u;
const MAX_DESKTOP_ERROR_LENGTH = 240;

function desktopActionErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(ELECTRON_INVOKE_ERROR_PREFIX, "").trim();
  return message && message.length <= MAX_DESKTOP_ERROR_LENGTH && !/[{}<>`]/u.test(message) ? message : "";
}

/**
 * Asks Desktop's Claude Code module to find `claude`, let the person pick it,
 * show its consent dialog for a login, set up or remove a login, or turn it
 * off, for the account and controller Desktop reads itself. Resolves to the
 * status after it; rejects with {@link ClaudeCodeDesktopActionError} when
 * Desktop refused or is not there. A consent dialog the person cancelled is
 * no refusal: the status after it just doesn't list the login.
 */
export async function invokeClaudeCodeDesktopAction(
  action: "detect" | "locate" | "enable" | "disable" | ClaudeCodeDesktopActionPayload,
  controllerUrl: string | null,
): Promise<ClaudeCodeDesktopStatus> {
  const bridge = desktopBridge();
  if (typeof bridge?.invokeDesktopExtension !== "function") {
    throw new ClaudeCodeDesktopActionError("");
  }
  const described: ClaudeCodeDesktopActionPayload = typeof action === "string" ? { action } : action;
  const payload = desktopPayload(described);
  const request: InstafyDesktopExtensionInvokeOptions = {
    extensionId: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
    method: described.action,
    ...(payload !== undefined ? { payload } : {}),
    ...(controllerUrl ? { controllerUrl } : {}),
  };
  let answer: unknown;
  try {
    answer = await bridge.invokeDesktopExtension(request);
  } catch (error) {
    throw new ClaudeCodeDesktopActionError(desktopActionErrorMessage(error));
  }
  const status = parseClaudeCodeDesktopStatus(answer);
  if (!status) {
    throw new ClaudeCodeDesktopActionError("");
  }
  // A Desktop that answers an action has the module, even if an earlier
  // status read was refused.
  desktopModuleRefused = false;
  return status;
}

/** The space Desktop runs a runtime for on this computer, and that runtime, or null. */
export async function readThisComputerRuntime(): Promise<{ projectId: string; runtimeId: string } | null> {
  const bridge = desktopBridge();
  if (typeof bridge?.desktopRuntimeStatus !== "function") {
    return null;
  }
  try {
    const status = await bridge.desktopRuntimeStatus();
    if (!status?.running) {
      return null;
    }
    const projectId = typeof status.projectId === "string" ? status.projectId.trim() : "";
    const runtimeId = typeof status.runtimeId === "string" ? status.runtimeId.trim() : "";
    return projectId && runtimeId ? { projectId, runtimeId } : null;
  } catch {
    return null;
  }
}

/**
 * The runtime Desktop runs for this space on this computer: the one whose id
 * its start call returned. Null when Desktop runs none, or one for another
 * space.
 */
export async function readThisComputerRuntimeId(projectId: string): Promise<string | null> {
  const runtime = await readThisComputerRuntime();
  return runtime && runtime.projectId === projectId ? runtime.runtimeId : null;
}
