import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Laptop } from "iconoir-react";
import { Button } from "../../components/Button";
import { EntityRow } from "../../components/EntityRow";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Text } from "../../components/Text";
import { formatUsageLimitResetTime } from "../../conversations/usageLimitReset";
import type { FrontendTurnEngineYourAiRowProps } from "../frontendFeatureModule";
import type { ControllerRuntimeClaudeCode } from "../../services/runtimeController/runtimes";
import {
  CLAUDE_CODE_COPY,
  claudeCodeDesktopProblemSentence,
  claudeCodeLoginRefusalSentence,
  claudeCodeSignInLine,
} from "./claudeCodeCopy";
import {
  ClaudeCodeDesktopActionError,
  claudeCodeDesktopHostAvailable,
  claudeCodeLoginSetUpHere,
  invokeClaudeCodeDesktopAction,
  readClaudeCodeDesktopStatus,
  readThisComputerRuntime,
  type ClaudeCodeDesktopFolderChoice,
  type ClaudeCodeDesktopLogin,
  type ClaudeCodeDesktopStatus,
} from "./claudeCodeDesktop";
import {
  loadClaudeCodeLogins,
  useClaudeCodeLoginsSnapshot,
  type ClaudeCodeLogin,
} from "./claudeCodeLoginsStore";
import { claudeCodeRuntimeLogin } from "./claudeCodeTurnPresentation";

const COPY = CLAUDE_CODE_COPY.yourAi;
const LOGINS = COPY.logins;
/** Per viewer: the one-time note was read (5.3). Never needed for anything to work. */
export const CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY = "instafy.claudeCode.firstUseNoteRead.v1";
/** The most logins a person has (runtime-contracts' MAX_LOGINS). */
const MAX_LOGINS = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A change that leaves Claude Code on alters the running runtime's grant, so
 * Desktop replaces that runtime before it answers (docs/Local-Engine-Turns.md
 * 4.3), and the new one is listed only once it has registered with the
 * controller. The waits between the reads that look for it: about 30 s in all.
 */
export const CLAUDE_CODE_SETTLE_DELAYS_MS = [1_000, 2_000, 3_000, 4_000, 5_000, 7_000, 8_000] as const;

// The controller client reads the session, which imports the application's
// feature composition and so this module: the row loads it when the person
// changes a login, never while the feature manifest is being evaluated.
const loginsClient = () => import("../../services/runtimeController/claudeCodeLogins");

type Readings = {
  desktop: ClaudeCodeDesktopStatus;
  /** The space Desktop runs a runtime for here, or none. */
  runtimeListed: boolean;
  capability: ControllerRuntimeClaudeCode | null;
};

/** What one read found about this computer's runtime. */
type RuntimeReading = {
  runtimeId: string | null;
  listed: boolean;
  hasCapability: boolean;
};

/** Desktop's answer to a change, with the words of a step after it that failed, such as a delete. */
type DesktopChangeOutcome = { answer: ClaudeCodeDesktopStatus; error?: string | null };

/** A change to the person's logins the controller refused, in a plain sentence. */
class ClaudeCodeLoginChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeLoginChangeError";
  }
}

/** The one small form the row shows at a time. */
type LoginForm =
  /** Name the first login of this computer, for a person who already has logins elsewhere. */
  | { kind: "enable"; name: string }
  /** Name and folder of another login. */
  | { kind: "add"; name: string; folder: ClaudeCodeDesktopFolderChoice }
  /** The folder of a login the person has, set up on this computer. */
  | { kind: "setUp"; loginId: string; folder: ClaudeCodeDesktopFolderChoice }
  | { kind: "rename"; loginId: string; name: string };

/**
 * One login as the row lists it: one of the person's, set up here or not, or
 * one this computer has set up that the person no longer has (deleted on
 * another computer), which can only be removed from here.
 */
type LoginRow = {
  id: string;
  login: ClaudeCodeLogin | null;
  here: ClaudeCodeDesktopLogin | null;
};

/** A runtime other than the one before the change is listed, with what it reported. */
function replacedRuntimeListed(reading: RuntimeReading | undefined, previousRuntimeId: string): boolean {
  return Boolean(reading && reading.listed && reading.hasCapability && reading.runtimeId !== previousRuntimeId);
}

/**
 * The space whose status says whether Claude Code turns are on for this
 * person: the one Desktop runs a runtime for on this computer, else the one
 * Studio has open (as ProjectAccessProvider publishes it for code outside
 * React's tree).
 */
function openSpaceId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = (window as Window & { __INSTAFY_ACTIVE_PROJECT_ID__?: unknown }).__INSTAFY_ACTIVE_PROJECT_ID__;
  return typeof value === "string" && UUID_PATTERN.test(value.trim()) ? value.trim() : null;
}

function readFirstUseNoteRead(): boolean {
  try {
    return window.localStorage.getItem(CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFirstUseNoteRead(): void {
  try {
    window.localStorage.setItem(CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY, "1");
  } catch {
    // The note shows again next time; nothing depends on it.
  }
}

/**
 * What the row says about this computer's Claude Code program once it is on.
 * While Desktop replaces the runtime after a change (`settling`), a runtime
 * not yet listed, or listed without what it reports, is still being checked.
 */
function readinessSentence(readings: Readings, settling: boolean): string {
  if (!readings.runtimeListed) {
    return settling ? COPY.checking : COPY.notRunning;
  }
  const capability = readings.capability;
  if (!capability) {
    return settling ? COPY.checking : COPY.notReadyYet;
  }
  if (capability.ready) {
    return COPY.ready;
  }
  return capability.reason ? COPY.notReady[capability.reason] : COPY.notReadyYet;
}

/**
 * What this computer says of one login set up here (11.19): ready, not signed
 * in yet, at its plan's limit until a time, or a folder Desktop or the
 * runtime refuses. Null while the row's own line says why the program can't
 * be checked or can't take turns, which holds for every login alike.
 */
function loginReadinessSentence(
  here: ClaudeCodeDesktopLogin,
  readings: Readings,
  settling: boolean,
  now: number,
): string | null {
  if (here.problem) {
    return LOGINS.folderUnusable;
  }
  const capability = readings.capability;
  if (!readings.runtimeListed || !capability || !capability.ready) {
    return null;
  }
  const attested = claudeCodeRuntimeLogin(capability, here.id);
  if (!attested) {
    return settling ? COPY.checking : LOGINS.notCheckedYet;
  }
  if (attested.ready) {
    // A sign-out never makes a login not ready (3.2): its turn would fail as
    // not signed in, so the row says so first.
    if (attested.signedIn === false) {
      return here.folder ? LOGINS.notSignedIn : LOGINS.notSignedInUsualFolder;
    }
    return LOGINS.ready;
  }
  if (attested.reason === "plan_limit") {
    const resetsAt = attested.resetsAt ? Date.parse(attested.resetsAt) : Number.NaN;
    return Number.isFinite(resetsAt) && resetsAt > now
      ? `${LOGINS.planLimitBefore} ${formatUsageLimitResetTime(resetsAt, now)}.`
      : LOGINS.planLimitNoTime;
  }
  if (attested.reason === "binary_unsafe") {
    return LOGINS.folderUnusable;
  }
  return attested.reason ? COPY.notReady[attested.reason] : COPY.notReadyYet;
}

/**
 * Whether every login this computer's runtime attests for the logins set up
 * here found a Claude plan sign-in, the one kind of sign-in a runtime reports
 * (2.10): only then does the row name the plan.
 */
function planSignInHere(readings: Readings): boolean {
  const attested = readings.desktop.logins
    .map((login) => claudeCodeRuntimeLogin(readings.capability, login.id))
    .filter((login) => login !== null);
  return attested.length > 0 && attested.every((login) => login.planSignIn);
}

/** The person's logins in the controller's order, oldest first, then any this computer still has that they deleted. */
function loginRows(logins: readonly ClaudeCodeLogin[] | null, here: readonly ClaudeCodeDesktopLogin[]): LoginRow[] {
  if (!logins) {
    return [];
  }
  const hereById = new Map(here.map((login) => [login.id, login]));
  const rows: LoginRow[] = logins.map((login) => ({ id: login.id, login, here: hereById.get(login.id) ?? null }));
  for (const login of here) {
    if (!logins.some((candidate) => candidate.id === login.id)) {
      rows.push({ id: login.id, login: null, here: login });
    }
  }
  return rows;
}

/** Why Desktop won't use the copy in use, in words, or null. */
function inUseProblemSentence(desktop: ClaudeCodeDesktopStatus): string | null {
  if (!desktop.problem) {
    return null;
  }
  // Desktop names the login-shell setting of the copy in use when its problem is one.
  const shellSetting = desktop.problem === "shell_setting_unusable" ? desktop.shellSetting ?? null : null;
  return claudeCodeDesktopProblemSentence(desktop.problem, shellSetting);
}

/**
 * Where the row says Claude Code is: the copy Desktop found or uses, also
 * when only a login-shell setting with it is unusable. Desktop checks those
 * settings only once the program itself passed (4.1, D26), so that copy was
 * found. Null for anything else.
 */
function foundPath(desktop: ClaudeCodeDesktopStatus): string | null {
  if (!desktop.path) {
    return null;
  }
  return desktop.found || desktop.problem === "shell_setting_unusable" ? desktop.path : null;
}

/**
 * While it is on: what the last Find or Locate turned up beside the copy in
 * use, which turns keep using until Use Claude Code on this computer confirms
 * another one, or new login-shell settings for this one
 * (docs/Local-Engine-Turns.md 4.1). Null when it turned up nothing else.
 */
function candidateReadings(desktop: ClaudeCodeDesktopStatus): {
  path: string | null;
  sentence: string;
  usable: boolean;
  /** New login-shell settings for the copy in use, not another copy. */
  renewsInUse: boolean;
} | null {
  if (!desktop.consented) {
    return null;
  }
  // Desktop offers the copy in use itself, with no problem, when Find read
  // login-shell settings for it that Desktop can use in place of recorded ones
  // it no longer can (D26). Use Claude Code on this computer confirms those,
  // as it would another copy.
  const renewsInUse = Boolean(desktop.candidatePath) && desktop.candidatePath === desktop.path;
  const path = desktop.candidatePath && !renewsInUse ? desktop.candidatePath : null;
  const problem = desktop.candidateProblem ?? null;
  if (!problem) {
    if (path) {
      return { path, sentence: COPY.candidateUse, usable: true, renewsInUse: false };
    }
    return renewsInUse ? { path: null, sentence: COPY.candidateRenewed, usable: true, renewsInUse: true } : null;
  }
  if (problem === "not_found") {
    return { path: null, sentence: COPY.candidateNotFound, usable: false, renewsInUse: false };
  }
  // Desktop names a login-shell setting for the candidate only when the copy in use has none of its own.
  const shellSetting =
    problem === "shell_setting_unusable" && desktop.problem !== "shell_setting_unusable"
      ? desktop.shellSetting ?? null
      : null;
  return { path, sentence: claudeCodeDesktopProblemSentence(problem, shellSetting), usable: false, renewsInUse: false };
}

/**
 * Creates a login, has Desktop set it up on this computer, and deletes it
 * again when Desktop didn't (the person cancelled its dialog, or Desktop
 * refused): a login no computer has set up would only be in the way.
 */
async function createAndSetUpLogin(
  label: string,
  setUp: (login: ClaudeCodeLogin) => Promise<ClaudeCodeDesktopStatus>,
): Promise<DesktopChangeOutcome> {
  const client = await loginsClient();
  const normalized = client.normalizeClaudeCodeLoginLabel(label);
  if (!normalized) {
    throw new ClaudeCodeLoginChangeError(LOGINS.errors.labelInvalid);
  }
  const created = await client.createClaudeCodeLogin(normalized);
  if (!created.success) {
    throw new ClaudeCodeLoginChangeError(claudeCodeLoginRefusalSentence(created.code));
  }
  const login = created.login;
  let answer: ClaudeCodeDesktopStatus;
  try {
    answer = await setUp(login);
  } catch (error) {
    await client.deleteClaudeCodeLogin(login.id).catch(() => null);
    throw error;
  }
  if (!claudeCodeLoginSetUpHere(answer, login.id)) {
    await client.deleteClaudeCodeLogin(login.id).catch(() => null);
  }
  return { answer };
}

/**
 * "Claude Code on this computer" in Your AI (docs/Local-Engine-Turns.md
 * 5.4, 11.19): where Desktop found `claude`, the actions that find it, pick
 * it, turn it on through Desktop's own consent dialog and turn it off, and
 * the person's Claude Code logins, each with its folder on this computer and
 * whether this computer can take a turn on it now, with what to do when it
 * can't. It shows only in Instafy Desktop where its module is supported
 * (macOS in v1), and only for a person the controller's lane covers. Like the
 * Instafy AI row it is not a connection; unlike it, it is never the default.
 */
export function ClaudeCodeYourAiRow({ fetchRuntimeStatus, resolveControllerUrl }: FrontendTurnEngineYourAiRowProps) {
  const [readings, setReadings] = useState<Readings | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loginsFailed, setLoginsFailed] = useState(false);
  const [form, setForm] = useState<LoginForm | null>(null);
  const [firstUseNoteRead, setFirstUseNoteRead] = useState(readFirstUseNoteRead);
  const [settling, setSettling] = useState(false);
  const logins = useClaudeCodeLoginsSnapshot();
  const formId = useId();
  const generationRef = useRef(0);
  /** Bumped to stop the reads after a change: by the next action, or unmounting. */
  const settleTokenRef = useRef(0);
  /**
   * While the row waits for a runtime Desktop started in place of another:
   * that other runtime's id. A later action that replaces nothing, or that
   * Desktop refused, leaves the wait to go on from it.
   */
  const waitingPastRef = useRef<string | null>(null);
  const latestRef = useRef({ fetchRuntimeStatus, resolveControllerUrl });
  latestRef.current = { fetchRuntimeStatus, resolveControllerUrl };

  /** Lists the person's logins again, for the row and everything else that names one. */
  const listLogins = useCallback(async () => {
    const listed = await loadClaudeCodeLogins();
    setLoginsFailed(listed === null);
  }, []);

  const refresh = useCallback(
    async (
      desktopAnswer?: ClaudeCodeDesktopStatus,
      { withLogins = false }: { withLogins?: boolean } = {},
    ): Promise<RuntimeReading | undefined> => {
      const generation = ++generationRef.current;
      if (!claudeCodeDesktopHostAvailable()) {
        setReadings(null);
        return undefined;
      }
      const desktop =
        desktopAnswer ??
        (await readClaudeCodeDesktopStatus(await latestRef.current.resolveControllerUrl().catch(() => null)));
      if (generation !== generationRef.current) {
        return undefined;
      }
      if (!desktop?.supported) {
        setReadings(null);
        return undefined;
      }
      const runtime = await readThisComputerRuntime();
      const projectId = runtime?.projectId ?? openSpaceId();
      const status = projectId
        ? await latestRef.current.fetchRuntimeStatus({ projectId, quietOnAbort: true }).catch(() => null)
        : null;
      if (generation !== generationRef.current) {
        return undefined;
      }
      // Only for a person the lane covers; a status that could not be read
      // keeps what the row last showed.
      if (!status) {
        setReadings((current) => (current ? { ...current, desktop } : null));
        return undefined;
      }
      if (status.claudeCodeLane !== true) {
        setReadings(null);
        return undefined;
      }
      // The person's logins, for a person the lane covers only: nobody else
      // has any to list.
      if (withLogins) {
        await listLogins();
        if (generation !== generationRef.current) {
          return undefined;
        }
      }
      const entry = runtime
        ? status.runtimes.find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? null
        : null;
      setReadings({
        desktop,
        runtimeListed: entry !== null,
        capability: entry?.claudeCode ?? null,
      });
      return { runtimeId: runtime?.runtimeId ?? null, listed: entry !== null, hasCapability: Boolean(entry?.claudeCode) };
    },
    [listLogins],
  );

  useEffect(() => {
    void refresh(undefined, { withLogins: true });
    return () => {
      generationRef.current += 1;
      settleTokenRef.current += 1;
    };
  }, [refresh]);

  /**
   * After a change for which Desktop started a runtime in place of
   * `previousRuntimeId`: read again until the new one is listed with what it
   * reported, for about 30 s at most. It ends early when Desktop runs none,
   * which has nothing to report, or runs the replaced one again. Another
   * action, or unmounting, stops it; the next action may go on from it.
   */
  const readUntilReplaced = useCallback(
    async (token: number, previousRuntimeId: string, first: RuntimeReading | undefined) => {
      let reading = first;
      for (const delay of CLAUDE_CODE_SETTLE_DELAYS_MS) {
        if (token !== settleTokenRef.current) {
          return;
        }
        if (
          replacedRuntimeListed(reading, previousRuntimeId) ||
          reading?.runtimeId === null ||
          reading?.runtimeId === previousRuntimeId
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (token !== settleTokenRef.current) {
          return;
        }
        reading = await refresh();
      }
      if (token === settleTokenRef.current) {
        waitingPastRef.current = null;
        setSettling(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const onFocus = () => void refresh(undefined, { withLogins: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  /**
   * A change Desktop makes on this computer, keyed by the control that asked
   * for it (`key`): `change` asks Desktop, and may ask the controller before
   * or after. Resolves to whether Desktop answered.
   */
  const runDesktopChange = useCallback(
    async (key: string, change: (controllerUrl: string | null) => Promise<DesktopChangeOutcome>): Promise<boolean> => {
      setPendingAction(key);
      setActionError(null);
      // Stops the reads of an earlier change; this action goes on from it, or ends it.
      const token = ++settleTokenRef.current;
      const waitingPast = waitingPastRef.current;
      try {
        const controllerUrl = await latestRef.current.resolveControllerUrl().catch(() => null);
        // The runtime this change may replace: the one an earlier change's
        // wait looks past, else the one Desktop runs now, read now (the
        // row's last read may be older than a start made since).
        const previousRuntimeId =
          waitingPast ?? (await readThisComputerRuntime().catch(() => null))?.runtimeId ?? null;
        const { answer, error } = await change(controllerUrl);
        // When Desktop answers, it has already replaced a running runtime
        // whose grant the change altered, and a replacement always has a new
        // id (4.3). The same id means it kept that runtime, such as a
        // Personal Browser one or one whose grant didn't change; none means
        // nothing runs, or the replacement didn't start. Either way there is
        // nothing new to wait for.
        const currentRuntimeId = answer.consented
          ? (await readThisComputerRuntime().catch(() => null))?.runtimeId ?? null
          : null;
        const replaced = previousRuntimeId !== null && currentRuntimeId !== null && currentRuntimeId !== previousRuntimeId;
        waitingPastRef.current = replaced ? previousRuntimeId : null;
        setSettling(replaced);
        if (error) {
          setActionError(error);
        }
        const reading = await refresh(answer, { withLogins: true });
        if (replaced && previousRuntimeId !== null) {
          void readUntilReplaced(token, previousRuntimeId, reading);
        }
        return true;
      } catch (error) {
        const resumeToken = ++settleTokenRef.current;
        const words =
          error instanceof ClaudeCodeDesktopActionError || error instanceof ClaudeCodeLoginChangeError
            ? error.message
            : "";
        setActionError(words || COPY.actionFailed);
        // A refused change may have been put back after another read began
        // (a focus while Desktop asked, say): read the status again, so the
        // row never shows that change beside the words that say it wasn't made.
        // A runtime an earlier change started may still be registering: go on
        // waiting for it.
        if (waitingPast !== null) {
          void refresh(undefined, { withLogins: true }).then((reading) =>
            readUntilReplaced(resumeToken, waitingPast, reading),
          );
        } else {
          setSettling(false);
          void refresh(undefined, { withLogins: true });
        }
        return false;
      } finally {
        setPendingAction(null);
      }
    },
    [readUntilReplaced, refresh],
  );

  /**
   * A change to the person's logins that only the controller makes, such as
   * a rename: `change` resolves to the sentence for a refusal, or null.
   * Resolves to whether it was made.
   */
  const runLoginChange = useCallback(
    async (key: string, change: () => Promise<string | null>): Promise<boolean> => {
      setPendingAction(key);
      setActionError(null);
      try {
        const refusal = await change().catch(() => LOGINS.errors.changeFailed);
        if (refusal) {
          setActionError(refusal);
        }
        await listLogins();
        return refusal === null;
      } finally {
        setPendingAction(null);
      }
    },
    [listLogins],
  );

  const runAction = useCallback(
    (action: "detect" | "locate" | "disable" | "enable") =>
      runDesktopChange(action, async (controllerUrl) => ({
        answer: await invokeClaudeCodeDesktopAction(action, controllerUrl),
      })),
    [runDesktopChange],
  );

  /**
   * Use Claude Code on this computer, with nothing set up here yet: a new
   * login first, named "Claude Code" unless the person names it, then
   * Desktop's dialog for it (11.19).
   */
  const enableWithNewLogin = useCallback(
    (label: string) =>
      runDesktopChange("enable", (controllerUrl) =>
        createAndSetUpLogin(label, (login) =>
          invokeClaudeCodeDesktopAction(
            { action: "enable", login: { loginId: login.id, label: login.label } },
            controllerUrl,
          ),
        ),
      ),
    [runDesktopChange],
  );

  const addLogin = useCallback(
    (label: string, folder: ClaudeCodeDesktopFolderChoice) =>
      runDesktopChange("add", (controllerUrl) =>
        createAndSetUpLogin(label, (login) =>
          invokeClaudeCodeDesktopAction(
            { action: "addLogin", login: { loginId: login.id, label: login.label }, folder },
            controllerUrl,
          ),
        ),
      ),
    [runDesktopChange],
  );

  /**
   * One of the person's logins, set up on this computer: the first one here
   * through `enable`, which takes the folder the login shell names (or the
   * usual one), and another through `addLogin`, in the folder chosen. A
   * cancelled dialog leaves the login as it is: other computers may have it.
   */
  const setUpLogin = useCallback(
    (login: ClaudeCodeLogin, folder: ClaudeCodeDesktopFolderChoice | null) =>
      runDesktopChange(`setUp:${login.id}`, async (controllerUrl) => ({
        answer: await invokeClaudeCodeDesktopAction(
          folder
            ? { action: "addLogin", login: { loginId: login.id, label: login.label }, folder }
            : { action: "enable", login: { loginId: login.id, label: login.label } },
          controllerUrl,
        ),
      })),
    [runDesktopChange],
  );

  const removeLoginHere = useCallback(
    (loginId: string) =>
      runDesktopChange(`remove:${loginId}`, async (controllerUrl) => ({
        answer: await invokeClaudeCodeDesktopAction({ action: "removeLogin", loginId }, controllerUrl),
      })),
    [runDesktopChange],
  );

  const renameLogin = useCallback(
    (loginId: string, name: string) =>
      runLoginChange(`rename:${loginId}`, async () => {
        const client = await loginsClient();
        const label = client.normalizeClaudeCodeLoginLabel(name);
        if (!label) {
          return LOGINS.errors.labelInvalid;
        }
        const renamed = await client.renameClaudeCodeLogin(loginId, label);
        return renamed.success ? null : claudeCodeLoginRefusalSentence(renamed.code);
      }),
    [runLoginChange],
  );

  /**
   * Deletes a login everywhere, once the person read what that does to the
   * agents that use it. Set up here, it is removed from this computer first,
   * so a change Desktop refused deletes nothing.
   */
  const deleteLogin = useCallback(
    async (login: ClaudeCodeLogin, setUpHere: boolean) => {
      if (typeof window !== "undefined" && !window.confirm(`Delete "${login.label}"? ${LOGINS.deleteConfirm}`)) {
        return;
      }
      const deleteEverywhere = async (): Promise<string | null> => {
        const deleted = await (await loginsClient()).deleteClaudeCodeLogin(login.id);
        return deleted.success ? null : claudeCodeLoginRefusalSentence(deleted.code);
      };
      if (!setUpHere) {
        await runLoginChange(`delete:${login.id}`, deleteEverywhere);
        return;
      }
      await runDesktopChange(`delete:${login.id}`, async (controllerUrl) => {
        const answer = await invokeClaudeCodeDesktopAction({ action: "removeLogin", loginId: login.id }, controllerUrl);
        return { answer, error: await deleteEverywhere().catch(() => LOGINS.errors.changeFailed) };
      });
    },
    [runDesktopChange, runLoginChange],
  );

  if (!readings) {
    return null;
  }
  const { desktop } = readings;
  const busy = pendingAction !== null;
  const path = foundPath(desktop);
  const candidate = candidateReadings(desktop);
  // Once Find read usable settings for the copy in use, the recorded setting's
  // sentence ("Your login shell sets … Fix it, then choose Find.") no longer
  // describes the shell, and its step is done: the candidate says what is left.
  const problem = candidate?.renewsInUse ? null : inUseProblemSentence(desktop);
  const planSignIn = planSignInHere(readings);
  // The note asks for a sign-in. A Claude plan sign-in, the one kind this
  // computer's runtime reports (2.10), shows Claude Code is signed in, so the
  // note is left out while every login here reports one, and while the row
  // checks a new runtime, which may report one. Other sign-ins still see it
  // until it is read.
  const showFirstUseNote = desktop.consented && !firstUseNoteRead && !planSignIn && !settling;
  const rows = loginRows(logins, desktop.logins);
  const personHasLogins = (logins?.length ?? 0) > 0;
  const atLoginLimit = (logins?.length ?? 0) >= MAX_LOGINS;
  const now = Date.now();
  // Desktop refuses a folder another login here already uses, the usual one
  // included: once one uses it, another login's folder is one to choose.
  const defaultFolder: ClaudeCodeDesktopFolderChoice = desktop.logins.some((login) => login.folder === null)
    ? "choose"
    : "usual";
  const pendingKey = (key: string) => pendingAction === key;
  const disabledFor = (key: string, unavailable = false) => unavailable || (busy && pendingAction !== key);

  const actionButton = (
    action: "detect" | "locate" | "enable" | "disable",
    label: string,
    { variant = "ghost", unavailable = false }: { variant?: "secondary" | "ghost"; unavailable?: boolean } = {},
  ) => (
    <Button
      key={action}
      variant={variant}
      size="xs"
      radius="full"
      isPending={pendingKey(action)}
      isDisabled={disabledFor(action, unavailable)}
      data-testid={`credentials-claude-code-${action}`}
      onPress={() => {
        // Off, it sets up a new login: named "Claude Code", or by the person
        // when they have logins already, which another name may be taken by.
        if (action === "enable" && !desktop.consented) {
          if (personHasLogins) {
            setForm({ kind: "enable", name: LOGINS.defaultLabel });
            return;
          }
          void enableWithNewLogin(LOGINS.defaultLabel);
          return;
        }
        void runAction(action);
      }}
    >
      {label}
    </Button>
  );

  const loginButton = (
    key: string,
    testId: string,
    label: string,
    onPress: () => void,
    { variant = "ghost", unavailable = false }: { variant?: "secondary" | "ghost"; unavailable?: boolean } = {},
  ) => (
    <Button
      variant={variant}
      size="xs"
      radius="full"
      isPending={pendingKey(key)}
      isDisabled={disabledFor(key, unavailable)}
      data-testid={testId}
      onPress={onPress}
    >
      {label}
    </Button>
  );

  const folderChoice = (testId: string, value: ClaudeCodeDesktopFolderChoice, onChange: (next: ClaudeCodeDesktopFolderChoice) => void) => (
    <Field label={LOGINS.folder} htmlFor={`${formId}-${testId}`}>
      <Select
        id={`${formId}-${testId}`}
        size="sm"
        value={value}
        disabled={busy}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value === "choose" ? "choose" : "usual")}
      >
        <option value="usual">{LOGINS.usualFolder}</option>
        <option value="choose">{LOGINS.chooseFolder}</option>
      </Select>
    </Field>
  );

  const nameField = (testId: string, value: string, onChange: (next: string) => void) => (
    <Field label={LOGINS.name} htmlFor={`${formId}-${testId}`}>
      <Input
        id={`${formId}-${testId}`}
        size="sm"
        value={value}
        maxLength={120}
        disabled={busy}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );

  /**
   * One of the row's small forms: Enter in its field or its submit button
   * does `submit` once, while it can; a form closes once its change was made
   * (or Desktop's dialog was answered), and stays with the words of a refusal.
   */
  const smallForm = ({
    testId,
    key,
    canSubmit,
    submit,
    submitLabel,
    children,
  }: {
    testId: string;
    key: string;
    canSubmit: boolean;
    submit: () => Promise<boolean>;
    submitLabel: string;
    children: ReactNode;
  }) => {
    const send = () => {
      if (busy || !canSubmit) {
        return;
      }
      void submit().then((done) => {
        if (done) {
          setForm(null);
        }
      });
    };
    return (
      <form
        className="space-y-2 pt-1"
        data-testid={testId}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {children}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            radius="full"
            isPending={pendingKey(key)}
            isDisabled={disabledFor(key, !canSubmit)}
            data-testid={`${testId}-submit`}
            onPress={send}
          >
            {submitLabel}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            radius="full"
            isDisabled={busy}
            data-testid={`${testId}-cancel`}
            onPress={() => setForm(null)}
          >
            {LOGINS.cancel}
          </Button>
        </div>
      </form>
    );
  };

  const loginItem = (row: LoginRow, index: number) => {
    const { login, here } = row;
    const testId = `credentials-claude-code-login-${row.id}`;
    const status = here ? loginReadinessSentence(here, readings, settling, now) : LOGINS.notSetUpHere;
    const renaming = form?.kind === "rename" && form.loginId === row.id ? form : null;
    const settingUp = form?.kind === "setUp" && form.loginId === row.id ? form : null;
    return (
      <li
        key={row.id}
        data-testid={testId}
        className={[
          "space-y-1 py-2",
          index > 0 ? "border-t border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]" : "",
        ].join(" ")}
      >
        {renaming && login ? (
          smallForm({
            testId: `${testId}-rename-form`,
            key: `rename:${login.id}`,
            canSubmit: renaming.name.trim().length > 0,
            submit: () => renameLogin(login.id, renaming.name),
            submitLabel: LOGINS.save,
            children: nameField(`${testId}-rename-name`, renaming.name, (name) => setForm({ ...renaming, name })),
          })
        ) : (
          <Text as="div" variant="bodyStrong" tone="primary" className="break-words" data-testid={`${testId}-label`}>
            {login ? login.label : LOGINS.deleted}
          </Text>
        )}
        {here ? (
          <Text as="div" variant="caption" tone="secondary" className="break-all" data-testid={`${testId}-folder`}>
            {here.folder ?? LOGINS.usualFolder}
          </Text>
        ) : null}
        {status ? (
          <Text as="div" variant="caption" tone="muted" data-testid={`${testId}-status`}>
            {status}
          </Text>
        ) : null}
        {settingUp && login
          ? smallForm({
              testId: `${testId}-set-up-form`,
              key: `setUp:${login.id}`,
              canSubmit: true,
              submit: () => setUpLogin(login, settingUp.folder),
              submitLabel: LOGINS.setUpSubmit,
              children: folderChoice(`${testId}-folder`, settingUp.folder, (folder) => setForm({ ...settingUp, folder })),
            })
          : null}
        {!renaming && !settingUp ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {login && !here
              ? loginButton(
                  `setUp:${login.id}`,
                  `${testId}-set-up`,
                  LOGINS.setUp,
                  () => {
                    // With nothing set up here, Desktop's first login takes the
                    // folder the login shell names, or the usual one; after
                    // that, the person says which folder is this login here.
                    if (desktop.consented) {
                      setForm({ kind: "setUp", loginId: login.id, folder: defaultFolder });
                    } else {
                      void setUpLogin(login, null);
                    }
                  },
                  // Desktop's consent dialog names the program it found or was shown.
                  { variant: "secondary", unavailable: !desktop.consented && !desktop.found },
                )
              : null}
            {login
              ? loginButton(`rename:${login.id}`, `${testId}-rename`, LOGINS.rename, () =>
                  setForm({ kind: "rename", loginId: login.id, name: login.label }),
                )
              : null}
            {here
              ? loginButton(`remove:${row.id}`, `${testId}-remove`, LOGINS.removeHere, () => void removeLoginHere(row.id))
              : null}
            {login
              ? loginButton(`delete:${login.id}`, `${testId}-delete`, LOGINS.delete, () => void deleteLogin(login, here !== null))
              : null}
          </div>
        ) : null}
      </li>
    );
  };

  const addForm = form?.kind === "add" ? form : null;
  const enableForm = form?.kind === "enable" ? form : null;
  const showLogins = desktop.consented || personHasLogins || loginsFailed;

  return (
    <div data-testid="credentials-claude-code-row">
      <EntityRow
        surface="outlined"
        density="rich"
        className="items-start"
        startClassName="pt-0.5"
        subtitleClassName="!whitespace-normal break-all"
        start={
          <span
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-slate-900 ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10"
            aria-hidden="true"
          >
            <Laptop className="h-5 w-5" />
          </span>
        }
        title={COPY.title}
        subtitle={
          <span data-testid="credentials-claude-code-path">{path ? `${COPY.foundAt} ${path}` : COPY.notFound}</span>
        }
        detail={
          <div className="space-y-1.5">
            <Text as="div" variant="caption" tone="muted" data-testid="credentials-claude-code-sign-in">
              {claudeCodeSignInLine(planSignIn)}
            </Text>
            <Text as="div" variant="caption" tone="muted" data-testid="credentials-claude-code-status" role="status">
              {problem ??
                (desktop.consented
                  ? readinessSentence(readings, settling)
                  : // Use Claude Code on this computer consents to a program found: before one is, it can't be chosen.
                    desktop.found
                    ? COPY.off
                    : COPY.offNotFound)}
            </Text>
            {desktop.consented && !problem ? (
              <Text as="div" variant="caption" tone="muted">
                {COPY.on}
              </Text>
            ) : null}
            {candidate ? (
              <div data-testid="credentials-claude-code-candidate" className="space-y-0.5">
                {candidate.path ? (
                  <Text
                    as="div"
                    variant="caption"
                    tone="secondary"
                    className="break-all"
                    data-testid="credentials-claude-code-candidate-path"
                  >
                    {`${COPY.candidateFoundAt} ${candidate.path}`}
                  </Text>
                ) : null}
                <Text as="div" variant="caption" tone="muted" data-testid="credentials-claude-code-candidate-status">
                  {candidate.sentence}
                </Text>
              </div>
            ) : null}
            {actionError ? (
              <Text as="div" variant="caption" tone="danger" role="alert" data-testid="credentials-claude-code-error">
                {actionError}
              </Text>
            ) : null}
            {showFirstUseNote ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="credentials-claude-code-first-use">
                <Text as="span" variant="caption" tone="secondary">
                  {COPY.firstUse}
                </Text>
                <Button
                  variant="text"
                  tone="muted"
                  size="xs"
                  radius="xl"
                  data-testid="credentials-claude-code-first-use-dismiss"
                  onPress={() => {
                    writeFirstUseNoteRead();
                    setFirstUseNoteRead(true);
                  }}
                >
                  {COPY.firstUseDismiss}
                </Button>
              </div>
            ) : null}
            {enableForm && !desktop.consented
              ? smallForm({
                  testId: "credentials-claude-code-enable-form",
                  key: "enable",
                  canSubmit: enableForm.name.trim().length > 0 && desktop.found,
                  submit: () => enableWithNewLogin(enableForm.name),
                  submitLabel: COPY.enable,
                  children: nameField("credentials-claude-code-enable-name", enableForm.name, (name) =>
                    setForm({ ...enableForm, name }),
                  ),
                })
              : null}
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {desktop.consented
                ? actionButton("disable", COPY.disable, { variant: "secondary" })
                : // Desktop's consent dialog names the program it found or was shown.
                  enableForm
                  ? null
                  : actionButton("enable", COPY.enable, { variant: "secondary", unavailable: !desktop.found })}
              {/* While it is on, another copy Find or Locate turned up, or new
                  login-shell settings Find read for the copy in use, are used
                  only once the person confirms them in Desktop's consent dialog. */}
              {desktop.consented && candidate?.usable ? actionButton("enable", COPY.enable, { variant: "secondary" }) : null}
              {actionButton("detect", COPY.find)}
              {actionButton("locate", COPY.locate)}
            </div>
            {showLogins ? (
              <div className="space-y-1 pt-2" data-testid="credentials-claude-code-logins">
                <Text as="div" variant="captionStrong" tone="secondary">
                  {LOGINS.title}
                </Text>
                {loginsFailed && !logins ? (
                  <Text as="div" variant="caption" tone="danger" data-testid="credentials-claude-code-logins-error">
                    {LOGINS.errors.listFailed}
                  </Text>
                ) : null}
                {rows.length > 0 ? <ul className="min-w-0">{rows.map(loginItem)}</ul> : null}
                {/* Another login needs Claude Code on here: the first one turns it on. */}
                {desktop.consented && logins ? (
                  addForm ? (
                    smallForm({
                      testId: "credentials-claude-code-login-add-form",
                      key: "add",
                      canSubmit: addForm.name.trim().length > 0,
                      submit: () => addLogin(addForm.name, addForm.folder),
                      submitLabel: LOGINS.addSubmit,
                      children: (
                        <>
                          {nameField("credentials-claude-code-login-add-name", addForm.name, (name) =>
                            setForm({ ...addForm, name }),
                          )}
                          {folderChoice("credentials-claude-code-login-add-folder", addForm.folder, (folder) =>
                            setForm({ ...addForm, folder }),
                          )}
                        </>
                      ),
                    })
                  ) : atLoginLimit ? (
                    <Text as="div" variant="caption" tone="muted" data-testid="credentials-claude-code-login-limit">
                      {LOGINS.atLimit}
                    </Text>
                  ) : (
                    <div className="pt-1">
                      {loginButton("add", "credentials-claude-code-login-add", LOGINS.add, () =>
                        setForm({ kind: "add", name: "", folder: defaultFolder }),
                      )}
                    </div>
                  )
                ) : null}
              </div>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
