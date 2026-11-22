import { useCallback, useSyncExternalStore } from "react";
import { readAgentSignIn, type AgentBackupAi } from "@instafy/sdk/agents";
import type {
  FrontendTurnEngineContribution,
  TurnEngineSignIn,
  TurnEngineSpeakerSignIn,
  TurnEngineTurnOwner,
} from "../features/frontendFeatureModule";
import { registeredTurnEngines } from "../features/turnEngineRegistry";
import type { ControllerCredentialListItem } from "../services/runtimeController/credentials";
import { resolveCredentialLabel } from "../utils/credentialFormatting";

/**
 * Which of a person's own sign-ins a turn ran on (docs/Local-Engine-Turns.md
 * 11.20, D51): a connection, or one of a turn engine's own sign-ins, such as
 * a login of its. The controller stamps a turn's reply and its failure
 * with `aiSignIn` (`backup` when it was not the agent's first AI), and a
 * failure at a plan's limit with `aiSignInNext`, the sign-in the agent's next
 * turns use. The stamps hold ids only, and only the controller writes them.
 *
 * Studio names a stamp for the sign-in's owner alone, by the names they gave
 * their own sign-ins: their connections as the chat last listed them, and
 * each engine's sign-ins through its `signIns` slot. An id that is not one of
 * the viewer's names nothing, so nobody else ever reads which sign-in ran a
 * turn. Nothing here names an engine.
 */

/** The stamp of the sign-in a turn ran on. */
export const AI_SIGN_IN_KEY = "aiSignIn";
/** The stamp of the sign-in an agent's next turns use, on a failure at a plan's limit. */
export const AI_SIGN_IN_NEXT_KEY = "aiSignInNext";
/** The key that names a connection in a sign-in. */
export const CONNECTION_SIGN_IN_KEY = "credentialId";

/** A stamp as the chat reads it. */
export type AiSignInStamp = {
  signIn: AgentBackupAi;
  /** It was one of the agent's backups, not its first AI. */
  backup: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stamp under `key` of a message's metadata, or null when it names no sign-in as the controller does. */
export function readAiSignInStamp(
  metadata: unknown,
  key: typeof AI_SIGN_IN_KEY | typeof AI_SIGN_IN_NEXT_KEY = AI_SIGN_IN_KEY,
): AiSignInStamp | null {
  const stamp = isRecord(metadata) ? metadata[key] : null;
  const signIn = readAgentSignIn(stamp);
  return signIn ? { signIn, backup: isRecord(stamp) && stamp["backup"] === true } : null;
}

/** The key that names a sign-in and its id. */
export function signInKeyOf(signIn: AgentBackupAi): { key: string; id: string } {
  const [key = "", id = ""] = Object.entries(signIn)[0] ?? [];
  return { key, id: typeof id === "string" ? id.toLowerCase() : "" };
}

/** One text per sign-in, for keys and comparisons. */
export function signInKey(signIn: AgentBackupAi): string {
  const { key, id } = signInKeyOf(signIn);
  return `${key}:${id}`;
}

export function sameSignIn(a: AgentBackupAi | null | undefined, b: AgentBackupAi | null | undefined): boolean {
  return Boolean(a && b) && signInKey(a as AgentBackupAi) === signInKey(b as AgentBackupAi);
}

/** A connection as a sign-in. */
export function connectionSignIn(credentialId: string): AgentBackupAi {
  return { credentialId: credentialId.trim().toLowerCase() };
}

/** One of a turn engine's sign-ins, by the key its `signIns` slot names them with. */
export function turnEngineSignIn(refKey: string, id: string): AgentBackupAi {
  return { [refKey]: id.trim().toLowerCase() } as AgentBackupAi;
}

// ---------------------------------------------------------------------------
// The viewer's connections, as the chat (useChatCredentialGate) and Your AI
// last listed them. Only their own listing writes them, and a list is kept
// for one signed-in person: another's never names anything.
// ---------------------------------------------------------------------------

let connections: readonly ControllerCredentialListItem[] | null = null;
let connectionsOwnerId: string | null = null;
/** The person signed in to the chat, once it said: a list of anyone else's is never kept. */
let viewerId: string | null | undefined;
const connectionListeners = new Set<() => void>();

function emitConnections(): void {
  for (const listener of [...connectionListeners]) {
    listener();
  }
}

/**
 * Puts in the viewer's connections as their own listing just returned them
 * (`ownerId` is whose they are), or null for none known. A list of someone
 * other than the person signed in to the chat now is dropped.
 */
export function setViewerConnections(
  ownerId: string | null,
  next: readonly ControllerCredentialListItem[] | null,
): void {
  if (next && (!ownerId || (viewerId !== undefined && ownerId !== viewerId))) {
    return;
  }
  connections = next ? Object.freeze([...next]) : null;
  connectionsOwnerId = connections ? ownerId : null;
  emitConnections();
}

/** Says who is signed in to the chat now, forgetting a list kept for anyone else. */
export function setViewerConnectionsOwner(ownerId: string | null): void {
  viewerId = ownerId;
  if (connections !== null && connectionsOwnerId !== ownerId) {
    connections = null;
    connectionsOwnerId = null;
    emitConnections();
  }
}

/** For tests: no list, and nobody signed in yet. */
export function resetViewerConnectionsForTests(): void {
  viewerId = undefined;
  connections = null;
  connectionsOwnerId = null;
  lastSnapshot = null;
  connectionListeners.clear();
}

/** The viewer's connections as last listed, revoked ones too; null before a list. */
export function viewerConnectionsSnapshot(): readonly ControllerCredentialListItem[] | null {
  return connections;
}

function subscribeViewerConnections(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

/** The connections Your AI lists: live ones a turn can run on. */
function listedConnections(list: readonly ControllerCredentialListItem[]): ControllerCredentialListItem[] {
  return list.filter(
    (credential) =>
      !credential.revokedAt && (credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"),
  );
}

// ---------------------------------------------------------------------------
// All of the viewer's sign-ins.
// ---------------------------------------------------------------------------

/** One turn engine's sign-ins for the viewer: null while its list has not loaded. */
export type ViewerEngineSignIns = {
  engine: FrontendTurnEngineContribution;
  signIns: readonly TurnEngineSignIn[] | null;
};

/** The viewer's own sign-ins, as far as Studio has listed them. */
export type ViewerSignIns = {
  /** Their connections, revoked ones too; null before a list. */
  connections: readonly ControllerCredentialListItem[] | null;
  /** Each turn engine's that has sign-ins. */
  engines: readonly ViewerEngineSignIns[];
};

let lastSnapshot: ViewerSignIns | null = null;

function sameEngineLists(a: readonly ViewerEngineSignIns[], b: readonly ViewerEngineSignIns[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.engine === b[index]?.engine && entry.signIns === b[index]?.signIns);
}

/** The viewer's sign-ins now: the same object until one of the lists changes. */
export function viewerSignInsSnapshot(): ViewerSignIns {
  const engines = registeredTurnEngines().flatMap((engine) =>
    engine.signIns ? [{ engine, signIns: engine.signIns.snapshot() }] : [],
  );
  if (lastSnapshot && lastSnapshot.connections === connections && sameEngineLists(lastSnapshot.engines, engines)) {
    return lastSnapshot;
  }
  lastSnapshot = Object.freeze({ connections, engines: Object.freeze(engines) });
  return lastSnapshot;
}

/**
 * What the chat watches of the viewer's sign-ins: nothing; their connections
 * only, which the chat lists anyway; or the engines' too, which subscribing
 * lists when no list is recent.
 */
export type ViewerSignInsScope = "off" | "connections" | "all";

function subscribeViewerSignIns(scope: ViewerSignInsScope, onChange: () => void): () => void {
  if (scope === "off") {
    return () => {};
  }
  const stops = [subscribeViewerConnections(onChange)];
  if (scope === "all") {
    for (const engine of registeredTurnEngines()) {
      if (engine.signIns) {
        stops.push(engine.signIns.subscribe(onChange));
      }
    }
  }
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}

/** The viewer's sign-ins for a component, watched by `scope`; null when it is "off". */
export function useViewerSignIns(scope: ViewerSignInsScope): ViewerSignIns | null {
  const subscribe = useCallback((onChange: () => void) => subscribeViewerSignIns(scope, onChange), [scope]);
  const read = () => (scope === "off" ? null : viewerSignInsSnapshot());
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Whether the viewer has more than one sign-in, connections and every
 * engine's together; null while the lists that would say have not loaded.
 */
export function viewerHasSeveralSignIns(signIns: ViewerSignIns): boolean | null {
  if (!signIns.connections) {
    return null;
  }
  let count = listedConnections(signIns.connections).length;
  let unknown = false;
  for (const { signIns: list } of signIns.engines) {
    if (list === null) {
      unknown = true;
    } else {
      count += list.length;
    }
  }
  return count > 1 ? true : unknown ? null : false;
}

/** The engine whose sign-ins `key` names, or null. */
function engineEntryOf(signIns: ViewerSignIns, key: string): ViewerEngineSignIns | null {
  return signIns.engines.find((entry) => entry.engine.signIns?.refKey === key) ?? null;
}

/**
 * The name of one of the viewer's own sign-ins: a connection by its label as
 * Your AI lists it, an engine's by the name its owner gave it. Null for an id
 * that is not one of theirs, and while its list has not loaded.
 */
export function viewerSignInLabel(signIn: AgentBackupAi, signIns: ViewerSignIns): string | null {
  const { key, id } = signInKeyOf(signIn);
  if (!id) {
    return null;
  }
  if (key === CONNECTION_SIGN_IN_KEY) {
    const credential = signIns.connections?.find((candidate) => candidate.id.toLowerCase() === id) ?? null;
    return credential ? resolveCredentialLabel(credential).trim() || null : null;
  }
  const label = engineEntryOf(signIns, key)?.signIns?.find((candidate) => candidate.id.toLowerCase() === id)?.label;
  return label?.trim() || null;
}

/**
 * Whether naming `signIn` for the viewer needs the engines' lists: one of an
 * engine's does, and, where the name shows only once the viewer has more
 * than one sign-in (`count`), so does one of their connections while their
 * connections alone do not make more than one. A connection that is not
 * theirs never does: it names nothing whatever the lists say.
 */
export function namingNeedsEngineSignIns(
  signIn: AgentBackupAi,
  viewerConnections: readonly ControllerCredentialListItem[] | null,
  count: boolean,
): boolean {
  const { key, id } = signInKeyOf(signIn);
  if (key !== CONNECTION_SIGN_IN_KEY) {
    return true;
  }
  if (!count || !viewerConnections || !viewerConnections.some((candidate) => candidate.id.toLowerCase() === id)) {
    return false;
  }
  return listedConnections(viewerConnections).length < 2;
}

/**
 * What a component that may name the sign-ins in `stamps` watches: nothing
 * when it shows none, and the engines' lists only when naming one needs them
 * ({@link namingNeedsEngineSignIns}), so a person who never sees one of an
 * engine's sign-ins never asks for that engine's list.
 */
export function viewerSignInsScopeFor(
  stamps: readonly (AgentBackupAi | null)[],
  options: { count: boolean },
): ViewerSignInsScope {
  const named = stamps.filter((signIn): signIn is AgentBackupAi => signIn !== null);
  if (named.length === 0) {
    return "off";
  }
  const viewerConnections = viewerConnectionsSnapshot();
  return named.some((signIn) => namingNeedsEngineSignIns(signIn, viewerConnections, options.count))
    ? "all"
    : "connections";
}

/**
 * The sign-in a reply ran on, as its line names it for the viewer: its label
 * and whether it was a backup. Null unless the reply's stamp names one of the
 * viewer's own sign-ins, they have more than one, and the chat does not know
 * the turn to be someone else's (`owner`, null when it cannot tell: an id of
 * the viewer's is on their own turns only).
 */
export function viewerReplySignIn(
  metadata: unknown,
  owner: TurnEngineTurnOwner | null,
  signIns: ViewerSignIns,
): { label: string; backup: boolean } | null {
  if (owner?.isViewer === false) {
    return null;
  }
  const stamp = readAiSignInStamp(metadata);
  if (!stamp || viewerHasSeveralSignIns(signIns) !== true) {
    return null;
  }
  const label = viewerSignInLabel(stamp.signIn, signIns);
  return label ? { label, backup: stamp.backup } : null;
}

/** The line under a reply that ran on one of the viewer's connections: "Ran on Work" or "Ran on Work, a backup". */
export function replySignInLine(
  metadata: unknown,
  owner: TurnEngineTurnOwner | null,
  signIns: ViewerSignIns,
): string | null {
  const signIn = viewerReplySignIn(metadata, owner, signIns);
  if (!signIn) {
    return null;
  }
  return signIn.backup ? `Ran on ${signIn.label}, a backup` : `Ran on ${signIn.label}`;
}

/** What a turn engine's speaker line is told of the sign-in its reply ran on, or null (see {@link viewerReplySignIn}). */
export function turnEngineReplySignIn(
  metadata: unknown,
  owner: TurnEngineTurnOwner | null,
  signIns: ViewerSignIns,
): TurnEngineSpeakerSignIn | null {
  const signIn = owner?.isViewer === true ? viewerReplySignIn(metadata, owner, signIns) : null;
  return signIn ? { backup: signIn.backup } : null;
}
