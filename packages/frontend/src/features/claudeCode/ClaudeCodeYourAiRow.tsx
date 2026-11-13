import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop } from "iconoir-react";
import { Button } from "../../components/Button";
import { EntityRow } from "../../components/EntityRow";
import { Text } from "../../components/Text";
import type { FrontendTurnEngineYourAiRowProps } from "../../screens/studio/components/CredentialsSettingsCard";
import type { ControllerRuntimeClaudeCode } from "../../services/runtimeController/runtimes";
import { CLAUDE_CODE_COPY, claudeCodeSignInLine } from "./claudeCodeCopy";
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

type Readings = {
  desktop: ClaudeCodeDesktopStatus;
  /** The space Desktop runs a runtime for here, or none. */
  runtimeListed: boolean;
  capability: ControllerRuntimeClaudeCode | null;
};

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

/** What the row says about this computer's Claude Code once it is on. */
function readinessSentence(readings: Readings): string {
  if (!readings.runtimeListed) {
    return COPY.notRunning;
  }
  const capability = readings.capability;
  if (!capability) {
    return COPY.notReadyYet;
  }
  if (capability.ready) {
    return COPY.ready;
  }
  return capability.reason ? COPY.notReady[capability.reason] : COPY.notReadyYet;
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
  const generationRef = useRef(0);
  const latestRef = useRef({ fetchRuntimeStatus, resolveControllerUrl });
  latestRef.current = { fetchRuntimeStatus, resolveControllerUrl };

  const refresh = useCallback(async (desktopAnswer?: ClaudeCodeDesktopStatus) => {
    const generation = ++generationRef.current;
    if (!claudeCodeDesktopHostAvailable()) {
      setReadings(null);
      return;
    }
    const desktop =
      desktopAnswer ??
      (await readClaudeCodeDesktopStatus(await latestRef.current.resolveControllerUrl().catch(() => null)));
    if (generation !== generationRef.current) {
      return;
    }
    if (!desktop?.supported) {
      setReadings(null);
      return;
    }
    const runtime = await readThisComputerRuntime();
    const projectId = runtime?.projectId ?? openSpaceId();
    const status = projectId
      ? await latestRef.current.fetchRuntimeStatus({ projectId, quietOnAbort: true }).catch(() => null)
      : null;
    if (generation !== generationRef.current) {
      return;
    }
    // Only for a person the lane covers; a status that could not be read
    // keeps what the row last showed.
    if (!status) {
      setReadings((current) => (current ? { ...current, desktop } : null));
      return;
    }
    if (status.claudeCodeLane !== true) {
      setReadings(null);
      return;
    }
    const entry = runtime
      ? status.runtimes.find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? null
      : null;
    setReadings({
      desktop,
      runtimeListed: entry !== null,
      capability: entry?.claudeCode ?? null,
    });
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

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
      try {
        const controllerUrl = await latestRef.current.resolveControllerUrl().catch(() => null);
        const answer = await invokeClaudeCodeDesktopAction(action, controllerUrl);
        await refresh(answer);
      } catch (error) {
        const words = error instanceof ClaudeCodeDesktopActionError ? error.message : "";
        setActionError(words || COPY.actionFailed);
      } finally {
        setPendingAction(null);
      }
    },
    [refresh],
  );

  if (!readings) {
    return null;
  }
  const { desktop, capability } = readings;
  const busy = pendingAction !== null;
  const problem = desktop.problem ? COPY.problems[desktop.problem] : null;
  const showFirstUseNote = desktop.consented && !firstUseNoteRead;
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
          <span data-testid="credentials-claude-code-path">
            {desktop.found && desktop.path ? `${COPY.foundAt} ${desktop.path}` : COPY.notFound}
          </span>
        }
        detail={
          <div className="space-y-1.5">
            <Text as="div" variant="caption" tone="muted" data-testid="credentials-claude-code-sign-in">
              {claudeCodeSignInLine(capability?.planSignIn === true)}
            </Text>
            <Text as="div" variant="caption" tone="muted" data-testid="credentials-claude-code-status" role="status">
              {problem ?? (desktop.consented ? readinessSentence(readings) : COPY.off)}
            </Text>
            {desktop.consented && !problem ? (
              <Text as="div" variant="caption" tone="muted">
                {COPY.on}
              </Text>
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
              {actionButton("detect", COPY.find)}
              {actionButton("locate", COPY.locate)}
            </div>
          </div>
        }
      />
    </div>
  );
}
