import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AGENT_BACKUP_AIS_MAX, type AgentBackupAi, type ControllerAgentProfile } from "@instafy/sdk/agents";
import type {
  FrontendTurnEngineContribution,
  TurnEngineAgentAiRequestFields,
  TurnEngineSignIn,
} from "../../../features/frontendFeatureModule";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import {
  CONNECTION_SIGN_IN_KEY,
  connectionSignIn,
  sameSignIn,
  signInKey,
  signInKeyOf,
  turnEngineSignIn,
} from "../../../conversations/aiSignIns";
import {
  formatCredentialKind,
  resolveCredentialAccountHint,
  resolveCredentialLabel,
} from "../../../utils/credentialFormatting";

/**
 * The agent editor's Backups list (docs/Settings-UI.md, Bot profiles;
 * docs/Local-Engine-Turns.md 11.20): after its first AI, an agent lists up to
 * {@link AGENT_BACKUP_AIS_MAX} more of its owner's sign-ins, in order, which
 * its next turns use once the one it runs on reaches its plan's limit. They
 * are the person's connections, and each turn engine's own sign-ins through
 * its `signIns` slot. Nothing here names an engine.
 */

/** One sign-in as Backups shows it: a row of the list, or a choice of Add a backup. */
export type AgentBackupItem = {
  /** One text per sign-in. */
  key: string;
  signIn: AgentBackupAi;
  label: string;
  /** What kind of sign-in it is, as its own list words it, or null. */
  description: string | null;
};

/** An engine's sign-ins as the editor has them: null while its list has not loaded. */
export type AgentBackupEngineSignIns = {
  engine: FrontendTurnEngineContribution;
  signIns: readonly TurnEngineSignIn[] | null;
};

/**
 * The agent's own first AI once the editor saves, as Backups needs it: null
 * for Instafy AI or the person's default, which have no backups; otherwise
 * the sign-in it runs on first, or null for an engine with none yet.
 */
export type AgentOwnAi = { signIn: AgentBackupAi | null } | null;

/**
 * The agent's own first AI once the editor saves (docs/Local-Engine-Turns.md
 * 11.20), by what the save sends: the turn engine chosen, with the sign-in it
 * runs on first by the engine's own fields; else the connection chosen; else,
 * for an edit that leaves its AI alone, the connection it pins. An agent left
 * on the person's default, or on Instafy AI, has none.
 */
export function resolveAgentOwnAi(input: {
  mode: "create" | "edit" | "octo";
  /** The turn engine chosen as its AI, or null for a connection or Instafy AI. */
  engine: FrontendTurnEngineContribution | null;
  agent: ControllerAgentProfile | null;
  engineFields: TurnEngineAgentAiRequestFields | null;
  /** The chosen engine is not the one it saved (none counts as one). */
  engineChanged: boolean;
  credentialDraft: string | null;
  credentialDirty: boolean;
  hasConnections: boolean;
}): AgentOwnAi {
  if (input.engine) {
    const signIns = input.engine.signIns;
    const firstId = signIns?.firstForAgent?.({ agent: input.agent, fields: input.engineFields }) ?? null;
    return { signIn: signIns && firstId ? turnEngineSignIn(signIns.refKey, firstId) : null };
  }
  const draft = (input.credentialDraft ?? "").trim();
  const chosen = draft ? { signIn: connectionSignIn(draft) } : null;
  if (input.mode === "create" || input.credentialDirty) {
    return chosen;
  }
  if (input.engineChanged) {
    // Leaving an engine sends the connection the pickers show, or none.
    return input.hasConnections ? chosen : null;
  }
  const saved = input.agent?.credentialId?.trim() ?? "";
  return saved ? { signIn: connectionSignIn(saved) } : null;
}

/** The controller's refusals of a save's backups, in plain words (11.20). */
const BACKUP_SAVE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  backup_ai_unknown: "A backup isn't one of your sign-ins anymore. Remove it, then save again.",
  backup_ai_repeated: "A backup is listed twice, or is this agent's own AI. Remove it, then save again.",
  backup_ai_limit: `An agent can have up to ${AGENT_BACKUP_AIS_MAX} backups.`,
  backup_ai_needs_own_ai: "Backups need an AI of this agent's own. Choose one of your connections first.",
});

/** The sentence for a save the controller refused for its backups, or null for any other refusal. */
export function describeBackupSaveRefusal(code: string | null | undefined): string | null {
  const key = code?.trim() ?? "";
  return Object.prototype.hasOwnProperty.call(BACKUP_SAVE_REFUSALS, key) ? BACKUP_SAVE_REFUSALS[key] ?? null : null;
}

/** The same sign-ins in the same order. */
export function sameBackupList(a: readonly AgentBackupAi[], b: readonly AgentBackupAi[]): boolean {
  return a.length === b.length && a.every((entry, index) => sameSignIn(entry, b[index]));
}

/** The list as it saves: never the agent's own first AI, each sign-in once, at most the limit. */
export function backupsToSave(entries: readonly AgentBackupAi[], ownAi: AgentOwnAi): AgentBackupAi[] {
  if (!ownAi) {
    return [];
  }
  const seen = new Set<string>();
  const kept: AgentBackupAi[] = [];
  for (const entry of entries) {
    const key = signInKey(entry);
    if (seen.has(key) || (ownAi.signIn && sameSignIn(entry, ownAi.signIn))) {
      continue;
    }
    seen.add(key);
    kept.push(entry);
  }
  return kept.slice(0, AGENT_BACKUP_AIS_MAX);
}

function connectionDescription(credential: ControllerCredentialListItem): string {
  const hint = resolveCredentialAccountHint(credential);
  return hint ? `${formatCredentialKind(credential)} · ${hint}` : formatCredentialKind(credential);
}

function connectionItem(credential: ControllerCredentialListItem): AgentBackupItem {
  const signIn = connectionSignIn(credential.id);
  return {
    key: signInKey(signIn),
    signIn,
    // As Connections names it.
    label: resolveCredentialLabel(credential),
    description: connectionDescription(credential),
  };
}

function engineItem(entry: AgentBackupEngineSignIns, signIn: TurnEngineSignIn): AgentBackupItem | null {
  const refKey = entry.engine.signIns?.refKey;
  if (!refKey) {
    return null;
  }
  const ref = turnEngineSignIn(refKey, signIn.id);
  return { key: signInKey(ref), signIn: ref, label: signIn.label, description: entry.engine.agentAi?.label ?? null };
}

/**
 * The list's rows, each named as its own list names it. A sign-in whose list
 * has not loaded yet reads "Loading…", one the person no longer has says so,
 * and one no engine of this Studio's names reads as another of theirs, so
 * each row can still be moved or removed, and saving keeps it.
 */
export function backupRows(
  entries: readonly AgentBackupAi[],
  sources: { credentialsById: ReadonlyMap<string, ControllerCredentialListItem>; engines: readonly AgentBackupEngineSignIns[] },
): AgentBackupItem[] {
  return entries.map((signIn) => {
    const { key, id } = signInKeyOf(signIn);
    if (key === CONNECTION_SIGN_IN_KEY) {
      const credential =
        sources.credentialsById.get(id) ??
        [...sources.credentialsById.values()].find((candidate) => candidate.id.toLowerCase() === id) ??
        null;
      return credential
        ? { ...connectionItem(credential), signIn }
        : { key: signInKey(signIn), signIn, label: "A connection you no longer have", description: null };
    }
    const entry = sources.engines.find((candidate) => candidate.engine.signIns?.refKey === key) ?? null;
    const engineSignIn = entry?.signIns?.find((candidate) => candidate.id.toLowerCase() === id) ?? null;
    const item = entry && engineSignIn ? engineItem(entry, engineSignIn) : null;
    if (item) {
      return { ...item, signIn };
    }
    return {
      key: signInKey(signIn),
      signIn,
      // No engine of this Studio's names it: still one of the person's own,
      // as the controller lists only those.
      label: !entry ? "Another of your sign-ins" : entry.signIns === null ? "Loading…" : "A sign-in you no longer have",
      description: entry?.engine.agentAi?.label ?? null,
    };
  });
}

/**
 * What Add a backup offers: the person's live connections as Connections
 * lists them, then each engine's sign-ins, by their own names, leaving out
 * the agent's own first AI and what the list already holds.
 */
export function backupChoices(input: {
  connections: readonly ControllerCredentialListItem[];
  engines: readonly AgentBackupEngineSignIns[];
  ownAi: AgentOwnAi;
  listed: readonly AgentBackupAi[];
}): AgentBackupItem[] {
  if (!input.ownAi) {
    return [];
  }
  const taken = new Set(input.listed.map(signInKey));
  if (input.ownAi.signIn) {
    taken.add(signInKey(input.ownAi.signIn));
  }
  const items: AgentBackupItem[] = [];
  for (const credential of input.connections) {
    const item = connectionItem(credential);
    if (!credential.revokedAt && !taken.has(item.key)) {
      items.push(item);
    }
  }
  for (const entry of input.engines) {
    for (const signIn of entry.signIns ?? []) {
      const item = engineItem(entry, signIn);
      if (item && !taken.has(item.key)) {
        items.push(item);
      }
    }
  }
  return items;
}

/** How an agents list counts an agent's backups after its AI: "2 backups", or null for none. */
export function backupCountLabel(entries: readonly AgentBackupAi[] | null | undefined): string | null {
  const count = entries?.length ?? 0;
  if (count === 0) {
    return null;
  }
  return count === 1 ? "1 backup" : `${count} backups`;
}

function sameEngineSignIns(
  a: readonly AgentBackupEngineSignIns[],
  b: readonly AgentBackupEngineSignIns[],
): boolean {
  return a.length === b.length && a.every((entry, index) => entry.engine === b[index]?.engine && entry.signIns === b[index]?.signIns);
}

/**
 * The sign-ins of `engines` for the agent editor, watched while `open`, and
 * listed again each time it opens (`load(0)`), so a sign-in added elsewhere
 * shows. An engine that is not among them is never asked for its list.
 */
export function useAgentEditorEngineSignIns(
  engines: readonly FrontendTurnEngineContribution[],
  open: boolean,
): readonly AgentBackupEngineSignIns[] {
  const watched = open ? engines.filter((engine) => engine.signIns) : [];
  const watchedKey = watched.map((engine) => engine.id).join("\n");
  const watchedRef = useRef(watched);
  watchedRef.current = watched;
  const lastRef = useRef<readonly AgentBackupEngineSignIns[]>([]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = watchedRef.current.map((engine) => engine.signIns?.subscribe(onChange) ?? (() => {}));
      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
    // The engines watched, by id: the list itself is made anew each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watchedKey],
  );
  const read = () => {
    const next = watchedRef.current.map((engine) => ({ engine, signIns: engine.signIns?.snapshot() ?? null }));
    if (sameEngineSignIns(lastRef.current, next)) {
      return lastRef.current;
    }
    lastRef.current = next;
    return next;
  };
  const snapshot = useSyncExternalStore(subscribe, read, read);

  useEffect(() => {
    for (const engine of watchedRef.current) {
      engine.signIns?.load(0);
    }
  }, [watchedKey]);

  return snapshot;
}
