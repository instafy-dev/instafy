import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop } from "iconoir-react";
import { Button } from "../../components/Button";
import { EntityRow } from "../../components/EntityRow";
import { Text } from "../../components/Text";
import type { FrontendTurnEngineYourAiRowProps } from "../frontendFeatureModule";
import type { ControllerRuntimeClaudeCode } from "../../services/runtimeController/runtimes";
import { CLAUDE_CODE_COPY, claudeCodeDesktopProblemSentence, claudeCodeSignInLine } from "./claudeCodeCopy";
import {
  ClaudeCodeDesktopActionError,
  claudeCodeDesktopHostAvailable,
  invokeClaudeCodeDesktopAction,
  readClaudeCodeDesktopStatus,
  readThisComputerRuntime,
  type ClaudeCodeDesktopAction,
  type ClaudeCodeDesktopStatus,
} from "./claudeCodeDesktop";

const COPY = CLAUDE_CODE_COPY.yourAi;
/** Per viewer: the one-time note was read (5.3). Never needed for anything to work. */
export const CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY = "instafy.claudeCode.firstUseNoteRead.v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A change that leaves Claude Code on alters the running runtime's grant, so
 * Desktop replaces that runtime before it answers (docs/Local-Engine-Turns.md
 * 4.3), and the new one is listed only once it has registered with the
 * controller. The waits between the reads that look for it: about 30 s in all.
 */
export const CLAUDE_CODE_SETTLE_DELAYS_MS = [1_000, 2_000, 3_000, 4_000, 5_000, 7_000, 8_000] as const;

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
 * What the row says about this computer's Claude Code once it is on. While
 * Desktop replaces the runtime after a change (`settling`), a runtime not yet
 * listed, or listed without what it reports, is still being checked.
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
 * "Claude Code on this computer" in Your AI (docs/Local-Engine-Turns.md
 * 5.3): where Desktop found `claude`, the actions that find it, pick it,
 * turn it on through Desktop's own consent dialog and turn it off, and
 * whether this computer's runtime can take a turn now, with what to do when
 * it can't. It shows only in Instafy Desktop where its module is supported
 * (macOS in v1), and only for a person the controller's lane covers. Like the
 * Instafy AI row it is not a connection; unlike it, it is never the default.
 */
export function ClaudeCodeYourAiRow({ fetchRuntimeStatus, resolveControllerUrl }: FrontendTurnEngineYourAiRowProps) {
  const [readings, setReadings] = useState<Readings | null>(null);
  const [pendingAction, setPendingAction] = useState<ClaudeCodeDesktopAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [firstUseNoteRead, setFirstUseNoteRead] = useState(readFirstUseNoteRead);
  const [settling, setSettling] = useState(false);
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

  const refresh = useCallback(async (desktopAnswer?: ClaudeCodeDesktopStatus): Promise<RuntimeReading | undefined> => {
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
    const entry = runtime
      ? status.runtimes.find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? null
      : null;
    setReadings({
      desktop,
      runtimeListed: entry !== null,
      capability: entry?.claudeCode ?? null,
    });
    return { runtimeId: runtime?.runtimeId ?? null, listed: entry !== null, hasCapability: Boolean(entry?.claudeCode) };
  }, []);

  useEffect(() => {
    void refresh();
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
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const runAction = useCallback(
    async (action: ClaudeCodeDesktopAction) => {
      setPendingAction(action);
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
        const answer = await invokeClaudeCodeDesktopAction(action, controllerUrl);
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
        const reading = await refresh(answer);
        if (replaced && previousRuntimeId !== null) {
          void readUntilReplaced(token, previousRuntimeId, reading);
        }
      } catch (error) {
        const resumeToken = ++settleTokenRef.current;
        const words = error instanceof ClaudeCodeDesktopActionError ? error.message : "";
        setActionError(words || COPY.actionFailed);
        // A refused change may have been put back after another read began
        // (a focus while Desktop asked, say): read the status again, so the
        // row never shows that change beside the words that say it wasn't made.
        // A runtime an earlier change started may still be registering: go on
        // waiting for it.
        if (waitingPast !== null) {
          void refresh().then((reading) => readUntilReplaced(resumeToken, waitingPast, reading));
        } else {
          setSettling(false);
          void refresh();
        }
      } finally {
        setPendingAction(null);
      }
    },
    [readUntilReplaced, refresh],
  );

  if (!readings) {
    return null;
  }
  const { desktop, capability } = readings;
  const busy = pendingAction !== null;
  const path = foundPath(desktop);
  const candidate = candidateReadings(desktop);
  // Once Find read usable settings for the copy in use, the recorded setting's
  // sentence ("Your login shell sets … Fix it, then choose Find.") no longer
  // describes the shell, and its step is done: the candidate says what is left.
  const problem = candidate?.renewsInUse ? null : inUseProblemSentence(desktop);
  // The note asks for a sign-in. A Claude plan sign-in, the one kind this
  // computer's runtime reports (2.10), shows Claude Code is signed in, so the
  // note is left out while one is reported, and while the row checks a new
  // runtime, which may report one. Other sign-ins still see it until it is read.
  const showFirstUseNote =
    desktop.consented && !firstUseNoteRead && capability?.planSignIn !== true && !settling;
  const actionButton = (
    action: ClaudeCodeDesktopAction,
    label: string,
    { variant = "ghost", unavailable = false }: { variant?: "secondary" | "ghost"; unavailable?: boolean } = {},
  ) => (
    <Button
      key={action}
      variant={variant}
      size="xs"
      radius="full"
      isPending={pendingAction === action}
      isDisabled={unavailable || (busy && pendingAction !== action)}
      data-testid={`credentials-claude-code-${action}`}
      onPress={() => void runAction(action)}
    >
      {label}
    </Button>
  );

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
              {claudeCodeSignInLine(capability?.planSignIn === true)}
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
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {desktop.consented
                ? actionButton("disable", COPY.disable, { variant: "secondary" })
                : // Desktop's consent dialog names the program it found or was shown.
                  actionButton("enable", COPY.enable, { variant: "secondary", unavailable: !desktop.found })}
              {/* While it is on, another copy Find or Locate turned up, or new
                  login-shell settings Find read for the copy in use, are used
                  only once the person confirms them in Desktop's consent dialog. */}
              {desktop.consented && candidate?.usable ? actionButton("enable", COPY.enable, { variant: "secondary" }) : null}
              {actionButton("detect", COPY.find)}
              {actionButton("locate", COPY.locate)}
            </div>
          </div>
        }
      />
    </div>
  );
}
