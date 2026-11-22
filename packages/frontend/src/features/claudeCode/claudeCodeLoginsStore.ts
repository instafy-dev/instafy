import { useEffect, useSyncExternalStore } from "react";
import type {
  ControllerClaudeCodeLogin,
  ListClaudeCodeLoginsResult,
} from "../../services/runtimeController/claudeCodeLogins";

/**
 * The viewer's own Claude Code logins (docs/Local-Engine-Turns.md 11.19), as
 * `GET /me/claude-code-logins` last listed them, oldest first: the first is
 * their first login. Your AI's row, the agent editor's Login choice, the
 * agents list and the speaker line under a reply all read them here, and the
 * row writes what its own changes leave. Studio names only the viewer's own
 * logins, and only here does it learn their names.
 *
 * The list loads on demand, when something that names a login shows, so a
 * person who never sees a Claude Code turn never asks for it.
 */
export type ClaudeCodeLogin = ControllerClaudeCodeLogin;

/** How old a list may be before something that shows a login asks for it again. */
export const CLAUDE_CODE_LOGINS_MAX_AGE_MS = 5 * 60_000;

type Loader = () => Promise<ListClaudeCodeLoginsResult>;

// The controller client reads the session, which imports the application's
// feature composition and so this module: it loads when a list is first
// asked for, never while the feature manifest is being evaluated
// (docs/Local-Engine-Turns.md 5.1).
const loadFromController: Loader = async () => {
  const [{ listClaudeCodeLogins }, { watchClaudeCodeLoginsViewer }] = await Promise.all([
    import("../../services/runtimeController/claudeCodeLogins"),
    import("./claudeCodeLoginsViewer"),
  ]);
  watchClaudeCodeLoginsViewer(forgetClaudeCodeLogins);
  return listClaudeCodeLogins();
};

let loader: Loader = loadFromController;
/** The last list, or null before one loaded (or after the viewer changed). */
let logins: readonly ClaudeCodeLogin[] | null = null;
/** When the last list loaded, or the last load failed; 0 for never. */
let settledAt = 0;
let inFlight: Promise<readonly ClaudeCodeLogin[] | null> | null = null;
/** Bumped whenever the list is set or forgotten, so an older load never overwrites a newer list. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** The viewer's logins as last listed, or null while none has loaded. */
export function claudeCodeLoginsSnapshot(): readonly ClaudeCodeLogin[] | null {
  return logins;
}

/** Puts in a list the viewer's own action just read or left, such as Your AI's row after a change. */
export function setClaudeCodeLogins(next: readonly ClaudeCodeLogin[]): void {
  generation += 1;
  logins = Object.freeze([...next]);
  settledAt = Date.now();
  inFlight = null;
  emit();
}

/** Forgets the list, as when the person signed in to Studio changes. */
export function forgetClaudeCodeLogins(): void {
  generation += 1;
  logins = null;
  settledAt = 0;
  inFlight = null;
  emit();
}

/**
 * Lists the viewer's logins again, or joins a list already under way.
 * Resolves to the list, or null when the controller could not say; a list
 * that failed keeps the last one.
 */
export function loadClaudeCodeLogins(): Promise<readonly ClaudeCodeLogin[] | null> {
  if (inFlight) {
    return inFlight;
  }
  const started = generation;
  const load = loader()
    .catch((): ListClaudeCodeLoginsResult => ({ success: false, error: "", code: null }))
    .then((result) => {
      if (started !== generation) {
        return logins;
      }
      inFlight = null;
      settledAt = Date.now();
      if (!result.success) {
        emit();
        return null;
      }
      setClaudeCodeLogins(result.logins);
      return logins;
    });
  inFlight = load;
  return load;
}

/** Lists the viewer's logins when no list is younger than `maxAgeMs`, and none is under way. */
export function ensureClaudeCodeLogins(maxAgeMs: number = CLAUDE_CODE_LOGINS_MAX_AGE_MS): void {
  if (inFlight || (settledAt > 0 && Date.now() - settledAt < maxAgeMs)) {
    return;
  }
  void loadClaudeCodeLogins();
}

/**
 * Calls `listener` whenever the list changes, and lists the logins when no
 * list is recent: what shows a login subscribes while it shows.
 */
export function subscribeClaudeCodeLogins(listener: () => void): () => void {
  listeners.add(listener);
  ensureClaudeCodeLogins();
  return () => {
    listeners.delete(listener);
  };
}

function subscribeOnly(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The viewer's logins for a component, null until they load. It lists them
 * when it mounts if no list is younger than `maxAgeMs`; pass 0 to always ask
 * again, as the agent editor does each time it opens.
 */
export function useClaudeCodeLogins(maxAgeMs: number = CLAUDE_CODE_LOGINS_MAX_AGE_MS): readonly ClaudeCodeLogin[] | null {
  const current = useClaudeCodeLoginsSnapshot();
  useEffect(() => {
    ensureClaudeCodeLogins(maxAgeMs);
  }, [maxAgeMs]);
  return current;
}

/**
 * The viewer's logins as last listed, for a component that asks for them
 * itself only once it knows it shows (Your AI's row): it never lists them.
 */
export function useClaudeCodeLoginsSnapshot(): readonly ClaudeCodeLogin[] | null {
  return useSyncExternalStore(subscribeOnly, claudeCodeLoginsSnapshot, claudeCodeLoginsSnapshot);
}

/** The label of one of the viewer's logins by id, or null when it isn't one of them. */
export function claudeCodeLoginLabel(
  list: readonly ClaudeCodeLogin[] | null,
  loginId: string | null | undefined,
): string | null {
  if (!list || !loginId) {
    return null;
  }
  const id = loginId.toLowerCase();
  return list.find((login) => login.id === id)?.label ?? null;
}

/** For tests: lists with `next` instead of the controller, and starts with no list. */
export function setClaudeCodeLoginsLoaderForTests(next: Loader | null): void {
  loader = next ?? loadFromController;
  forgetClaudeCodeLogins();
  listeners.clear();
}
