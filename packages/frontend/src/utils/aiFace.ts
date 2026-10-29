import {
  getDefaultAssistantHandle,
  resolveBuiltInAssistantHandle,
} from "../assistants/localBuiltInAssistantCatalog";
import { hashStringToNumber, normalizeAgentAvatarHandle, normalizeCustomAgentAvatarSrc } from "./agentAvatar";

// One resolver for every AI face (docs/Brand.md, "Octo's hatchlings"). Octo
// is its tile; every other AI without a picture of its own wears one of
// Octo's eight hatchlings; an AI known only from text wears the hollow one.
// People never reach it: they stay round (HumanAvatar).
//
// Studio's copy of runtime-contracts' agent_face.rs. Both are pinned by
// packages/runtime-contracts/src/agent_face_fixtures.json, so a rule changed
// on one side and not the other fails here and in the Rust unit test at once.

/**
 * The numbered faces: 1 hooray, 2 drift, 3 kick, 4 twirl, 5 wave, 6 catch,
 * 7 rest, 8 swim. Their count is the hash modulus, and both are frozen: a face
 * added later takes a new seed prefix and is never renumbered.
 */
export const HATCHLINGS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type Hatchling = (typeof HATCHLINGS)[number];

/** The controller's (and the bot editor's) seed for a numbered face: exactly "hatchling:<n>". */
const HATCHLING_STAMP = /^hatchling:[1-8]$/;

/** The seed that stamps a numbered face, as the bot editor saves it. */
export function hatchlingSeed(face: Hatchling): string {
  return `hatchling:${face}`;
}

/** What a surface knows about an AI. A field that is left out is null. */
export type AiFaceIdentity = {
  handle?: string | null;
  avatarSeed?: string | null;
  avatarUrl?: string | null;
  agentId?: string | null;
  /** Printed beside the face or used for its accessible name; never decides the face. */
  displayName?: string | null;
  /**
   * The AI is known only by its handle: a conversation's AI in the mention
   * picker, the header roster or the participants drawer; a mention chip's
   * card; a thread's owner with no stamp yet. The caller sets it only after
   * finding none of the viewer's saved agents with that handle or id. An
   * identity read from a row (a message, run, job or question, or the Home
   * actor a row names) never is.
   */
  textOnly?: boolean;
};

/**
 * A face drawn on the AI tile: what a picture falls back to, never a picture
 * itself. A hatchling's `reason` says where its number came from: `stamp`, a
 * seed that names it; `legacy`, the hash of a seed from before stamps (or of
 * the agent id or handle). `unknown` is the hollow face, never stamped or
 * numbered.
 */
export type DrawnAiFace =
  | { kind: "octo" }
  | { kind: "hatchling"; n: Hatchling; reason: "stamp" | "legacy" }
  | { kind: "unknown" };

export type ResolvedAiFace = DrawnAiFace | { kind: "picture"; src: string; fallback: DrawnAiFace };

/** A stamp is read from the raw seed: no trimming and no case folding. */
function parseHatchlingStamp(seed: string | null | undefined): Hatchling | null {
  return typeof seed === "string" && HATCHLING_STAMP.test(seed) ? HATCHLINGS[Number(seed.slice(-1)) - 1] : null;
}

/**
 * Octo is decided by the handle alone, aliases included ("ai"). The handle is
 * normalized the way every Studio lookup does it (normalizeAgentAvatarHandle,
 * then the registry's own), so "@@octo" is Octo and "@@@octo" is not.
 */
function isOctoHandle(handle: string | null | undefined): boolean {
  return resolveBuiltInAssistantHandle(normalizeAgentAvatarHandle(handle)) === getDefaultAssistantHandle();
}

/** The face with every picture taken away. */
function resolveDrawnAiFace(identity: AiFaceIdentity): DrawnAiFace {
  const seed = normalizeCustomAgentAvatarSrc(identity.avatarSeed) ? null : identity.avatarSeed;
  const stamped = parseHatchlingStamp(seed);
  if (stamped) {
    return { kind: "hatchling", n: stamped, reason: "stamp" };
  }
  if (isOctoHandle(identity.handle)) {
    return { kind: "octo" };
  }
  if (identity.textOnly) {
    return { kind: "unknown" };
  }
  // Seed, else agent id, else handle: the order the controller stamps a
  // row's seed in (inject_agent_target_metadata), so an identity with an id
  // and no seed gets the face its rows will carry.
  for (const value of [seed, identity.agentId, identity.handle]) {
    const normalized = normalizeAgentAvatarHandle(value);
    if (normalized) {
      return { kind: "hatchling", n: HATCHLINGS[hashStringToNumber(normalized) % HATCHLINGS.length], reason: "legacy" };
    }
  }
  return { kind: "unknown" };
}

/**
 * An AI's face. The first rule that matches wins:
 * 1. a picture: avatarUrl, else a seed that is one ("/", "data:image/",
 *    http(s)), with the face to show if it fails to load;
 * 2. a stamp: a seed of exactly "hatchling:<n>", n from 1 to 8;
 * 3. Octo, by handle;
 * 4. the hollow face, for an AI known only from text;
 * 5. a legacy seed: hatchling 1 + FNV-1a(seed, else id, else handle) mod 8,
 *    after trimming, dropping one leading "@" and lowercasing;
 * 6. the hollow face, with nothing to hash.
 */
export function resolveAiFace(identity: AiFaceIdentity): ResolvedAiFace {
  const src =
    normalizeCustomAgentAvatarSrc(identity.avatarUrl) ?? normalizeCustomAgentAvatarSrc(identity.avatarSeed);
  const drawn = resolveDrawnAiFace(identity);
  return src ? { kind: "picture", src, fallback: drawn } : drawn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The identity a row's metadata.agent stamps, its agent id included. The
 * values stay as stamped (the resolver normalizes them, and a stamp must be
 * read raw). Null when the row names no AI, so the caller decides (an
 * unattributed assistant message is Octo).
 */
export function aiFaceIdentityFromMetadata(metadata: unknown): AiFaceIdentity | null {
  const agent = isRecord(metadata) ? metadata.agent : null;
  if (!isRecord(agent)) {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const identity = {
    handle: text(agent.handle),
    avatarSeed: text(agent.avatarSeed),
    avatarUrl: text(agent.avatarUrl),
    agentId: text(agent.id),
    displayName: text(agent.displayName),
  };
  const named = [identity.handle, identity.avatarSeed, identity.avatarUrl, identity.agentId].some((value) => value?.trim());
  return named ? identity : null;
}

/**
 * Which AI an entry is, for keying a stack (the typing row, branch rows, the
 * roster): its agent id, else its handle and seed. Two lanes that share a
 * handle but wear different stamps stay two entries.
 */
export function aiFaceKey(identity: AiFaceIdentity): string {
  const agentId = identity.agentId?.trim();
  if (agentId) {
    return `agent:${agentId}`;
  }
  return `handle:${normalizeAgentAvatarHandle(identity.handle)}|${identity.avatarSeed ?? ""}`;
}

/** Whether two faces look the same, so a stack folds the repeat into its count instead of drawing it twice. */
export function sameFace(a: ResolvedAiFace, b: ResolvedAiFace): boolean {
  switch (a.kind) {
    case "picture":
      return b.kind === "picture" && b.src === a.src;
    case "hatchling":
      return b.kind === "hatchling" && b.n === a.n;
    default:
      return b.kind === a.kind;
  }
}

/**
 * The faces a stack draws (the typing row, branch rows, the roster), from
 * entries already keyed one per AI: in order, at most `max`, and never the
 * same face twice, so a repeat folds into the stack's count instead of
 * standing beside its twin. `more` counts every entry left undrawn.
 */
export function stackAiFaces<T>(
  entries: readonly T[],
  identityOf: (entry: T) => AiFaceIdentity,
  max: number,
): { shown: T[]; more: number } {
  const shown: T[] = [];
  const faces: ResolvedAiFace[] = [];
  for (const entry of entries) {
    if (shown.length >= max) {
      break;
    }
    const face = resolveAiFace(identityOf(entry));
    if (!faces.some((drawn) => sameFace(drawn, face))) {
      shown.push(entry);
      faces.push(face);
    }
  }
  return { shown, more: entries.length - shown.length };
}

/**
 * A saved agent's current profile, as far as its face goes: its seed, and its
 * handle, by which an AI known only by name is found among the viewer's own.
 */
export type SavedAgentFace = { avatarSeed: string; handle?: string | null };

/**
 * A saved agent is drawn from its current profile, looked up by its agent id
 * where the Studio has it (the viewer's own agents), so a face its owner
 * picked again, or a picture added or removed, shows everywhere at once. Any
 * other identity keeps the face its row was stamped with.
 */
export function withSavedAgentFace(
  identity: AiFaceIdentity,
  savedAgents: ReadonlyMap<string, SavedAgentFace>,
): AiFaceIdentity {
  const saved = identity.agentId ? savedAgents.get(identity.agentId.trim()) : undefined;
  return saved ? { ...identity, avatarSeed: saved.avatarSeed, avatarUrl: null, textOnly: false } : identity;
}

/**
 * A new saved agent's face: the one its owner's picture-less agents wear
 * least, the highest number on a tie, so an owner's agents count down from 8
 * while a chat's helpers count up from 1. `ownerFaces` is each of the owner's
 * agents' hatchling; pictures and Octo have none and are left out.
 */
export function defaultAgentFace(ownerFaces: Iterable<Hatchling>): Hatchling {
  const worn = new Map<Hatchling, number>();
  for (const face of ownerFaces) {
    worn.set(face, (worn.get(face) ?? 0) + 1);
  }
  let least: Hatchling = HATCHLINGS[HATCHLINGS.length - 1];
  for (const face of [...HATCHLINGS].reverse()) {
    if ((worn.get(face) ?? 0) < (worn.get(least) ?? 0)) {
      least = face;
    }
  }
  return least;
}
