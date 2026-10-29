import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { hashStringToNumber, normalizeAgentAvatarHandle } from "../agentAvatar";
import {
  HATCHLINGS,
  aiFaceIdentityFromMetadata,
  aiFaceKey,
  defaultAgentFace,
  hatchlingSeed,
  resolveAiFace,
  sameFace,
  stackAiFaces,
  withSavedAgentFace,
  type AiFaceIdentity,
  type Hatchling,
  type ResolvedAiFace,
} from "../aiFace";

// Studio's copy of the face rule. The fixture list is runtime-contracts' own
// file, so a rule changed on one side and not the other fails here and in the
// Rust unit test at once.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");

type FixtureFace =
  | { kind: "octo" }
  | { kind: "unknown" }
  | { kind: "hatchling"; n: Hatchling }
  | { kind: "picture"; src: string; fallback: FixtureFace };

const FIXTURES = JSON.parse(
  readFileSync(resolve(repo, "packages/runtime-contracts/src/agent_face_fixtures.json"), "utf8"),
) as {
  hatchlingFaces: number;
  hashModulus: number;
  stamps: Array<{ seed: string; n: Hatchling }>;
  notStamps: string[];
  pictures: Array<{ value: string; src: string }>;
  notPictures: string[];
  octoHandles: string[];
  notOctoHandles: string[];
  normalize: Array<{ input: string; normalized: string }>;
  hashes: Array<{ input: string; fnv1a32: number }>;
  resolve: Array<{
    why: string;
    identity: Pick<AiFaceIdentity, "handle" | "avatarSeed" | "avatarUrl" | "agentId" | "textOnly">;
    face: FixtureFace;
    hashed?: { input: string; fnv1a32: number };
  }>;
  agentDefaults: Array<{ ownerFaces: Hatchling[]; face: Hatchling }>;
};

const IDENTITY_KEYS = ["handle", "avatarSeed", "avatarUrl", "agentId", "textOnly"];

/**
 * The fixture's face with Studio's `reason`: a hatchling is a legacy hash
 * exactly when the case names what was hashed, and otherwise comes from the
 * stamp its seed names.
 */
function expectedFace(face: FixtureFace, hashed: boolean): ResolvedAiFace {
  if (face.kind === "picture") {
    const fallback = expectedFace(face.fallback, hashed);
    if (fallback.kind === "picture") throw new Error("a picture never falls back to a picture");
    return { ...face, fallback };
  }
  return face.kind === "hatchling" ? { ...face, reason: hashed ? "legacy" : "stamp" } : face;
}

function hatchlingOf(face: ResolvedAiFace) {
  const drawn = face.kind === "picture" ? face.fallback : face;
  return drawn.kind === "hatchling" ? drawn : null;
}

describe("resolveAiFace, against runtime-contracts' agent_face_fixtures.json", () => {
  it("has eight faces, the frozen hash modulus", () => {
    expect(HATCHLINGS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(FIXTURES.hatchlingFaces).toBe(HATCHLINGS.length);
    expect(FIXTURES.hashModulus).toBe(HATCHLINGS.length);
  });

  it("reads exactly hatchling:1 to hatchling:8 as stamps, from the raw seed", () => {
    expect(FIXTURES.stamps.map((stamp) => stamp.n)).toEqual([...HATCHLINGS]);
    for (const { seed, n } of FIXTURES.stamps) {
      expect(resolveAiFace({ handle: "pia", avatarSeed: seed })).toEqual({ kind: "hatchling", n, reason: "stamp" });
    }
    for (const seed of FIXTURES.notStamps) {
      const face = resolveAiFace({ handle: "pia", avatarSeed: seed });
      expect(face.kind === "hatchling" && face.reason, JSON.stringify(seed)).toBe("legacy");
    }
  });

  it("takes a picture from avatarUrl or the seed, trimmed, and nothing else", () => {
    for (const { value, src } of FIXTURES.pictures) {
      expect(resolveAiFace({ handle: "pia", avatarUrl: value })).toMatchObject({ kind: "picture", src });
      expect(resolveAiFace({ handle: "pia", avatarSeed: value })).toMatchObject({ kind: "picture", src });
    }
    for (const value of FIXTURES.notPictures) {
      expect(resolveAiFace({ handle: "pia", avatarUrl: value }).kind, JSON.stringify(value)).not.toBe("picture");
      expect(resolveAiFace({ handle: "pia", avatarSeed: value }).kind, JSON.stringify(value)).not.toBe("picture");
    }
  });

  it("knows Octo by its handle and aliases, normalized as every Studio lookup does", () => {
    for (const handle of FIXTURES.octoHandles) {
      expect(resolveAiFace({ handle }), JSON.stringify(handle)).toEqual({ kind: "octo" });
    }
    for (const handle of FIXTURES.notOctoHandles) {
      expect(resolveAiFace({ handle }).kind, JSON.stringify(handle)).not.toBe("octo");
    }
  });

  it("normalizes and hashes like the contract: JavaScript's trim and lowercase, FNV-1a over UTF-16 units", () => {
    for (const { input, normalized } of FIXTURES.normalize) {
      expect(normalizeAgentAvatarHandle(input), JSON.stringify(input)).toBe(normalized);
    }
    for (const { input, fnv1a32 } of FIXTURES.hashes) {
      expect(hashStringToNumber(input), JSON.stringify(input)).toBe(fnv1a32);
    }
  });

  it.each(FIXTURES.resolve.map((entry) => [entry.why, entry] as const))("%s", (_why, entry) => {
    // A misspelt key would otherwise read as null and pass for the wrong reason.
    expect(Object.keys(entry.identity).filter((key) => !IDENTITY_KEYS.includes(key))).toEqual([]);
    const face = resolveAiFace(entry.identity);
    expect(face).toEqual(expectedFace(entry.face, Boolean(entry.hashed)));
    const hatchling = hatchlingOf(face);
    if (entry.hashed) {
      expect(hatchling?.reason).toBe("legacy");
      expect(hashStringToNumber(entry.hashed.input)).toBe(entry.hashed.fnv1a32);
      expect(hatchling?.n).toBe(1 + (entry.hashed.fnv1a32 % FIXTURES.hashModulus));
    } else if (hatchling) {
      // A face nobody hashed comes from the stamp its seed names.
      expect(entry.identity.avatarSeed).toBe(`hatchling:${hatchling.n}`);
    }
  });

  it("gives a new saved agent its owner's least-worn face, counting down from 8", () => {
    for (const { ownerFaces, face } of FIXTURES.agentDefaults) {
      expect(defaultAgentFace(ownerFaces), JSON.stringify(ownerFaces)).toBe(face);
    }
  });
});

describe("resolveAiFace in Studio", () => {
  it("draws an unattributed or legacy Octo row, and the 'ai' alias on an unstamped row, as Octo", () => {
    expect(resolveAiFace({ handle: "octo" })).toEqual({ kind: "octo" });
    expect(resolveAiFace({ handle: "octo", avatarSeed: "octo" })).toEqual({ kind: "octo" });
    expect(resolveAiFace(aiFaceIdentityFromMetadata({ agent: { handle: "ai", avatarSeed: "ai" } })!)).toEqual({ kind: "octo" });
    expect(resolveAiFace({ handle: "@AI" })).toEqual({ kind: "octo" });
  });

  it("lets a stamp beat Octo's alias, so a lane named ai is a hatchling", () => {
    expect(resolveAiFace({ handle: "ai", avatarSeed: "hatchling:2" })).toEqual({ kind: "hatchling", n: 2, reason: "stamp" });
    expect(resolveAiFace({ handle: "octo", avatarSeed: "hatchling:4" })).toEqual({ kind: "hatchling", n: 4, reason: "stamp" });
  });

  it("gives an AI known only from text the hollow face, unless it is Octo or stamped", () => {
    expect(resolveAiFace({ handle: "@ben", textOnly: true })).toEqual({ kind: "unknown" });
    expect(resolveAiFace({ handle: "ben", avatarSeed: "ben", textOnly: true })).toEqual({ kind: "unknown" });
    expect(resolveAiFace({ handle: "@octo", textOnly: true })).toEqual({ kind: "octo" });
    expect(resolveAiFace({ handle: "ben", avatarSeed: "hatchling:6", textOnly: true })).toMatchObject({ kind: "hatchling", n: 6 });
    // The same handle read from a row hashes instead.
    expect(resolveAiFace({ handle: "ben" })).toEqual({ kind: "hatchling", n: 3, reason: "legacy" });
  });

  it("ignores a leading @ and case, so @Ben in the picker is ben in the transcript", () => {
    const ben = resolveAiFace({ handle: "ben", avatarSeed: "ben" });
    for (const identity of [{ handle: "@Ben" }, { handle: " BEN " }, { handle: "x", avatarSeed: "@ben" }, { handle: "x", avatarSeed: "BEN" }]) {
      expect(resolveAiFace(identity), JSON.stringify(identity)).toEqual(ben);
    }
    // Only one @ is dropped.
    expect(resolveAiFace({ handle: "@@ben" })).not.toEqual(ben);
  });

  it("hashes a saved agent's id when its picture is its seed, as the face to fall back to", () => {
    const id = "3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10";
    expect(resolveAiFace({ handle: "pia", agentId: id, avatarSeed: "https://images.example/pia.png" })).toEqual({
      kind: "picture",
      src: "https://images.example/pia.png",
      fallback: resolveAiFace({ handle: "pia", agentId: id, avatarSeed: id }),
    });
  });
});

describe("aiFaceIdentityFromMetadata", () => {
  it("keeps the stamped agent whole, its id included, exactly as stamped", () => {
    expect(
      aiFaceIdentityFromMetadata({
        agent: { id: "agent-1", handle: "@Pia", displayName: "Pia", avatarSeed: " hatchling:3", avatarUrl: "/pia.png", description: "x" },
        multiAgentPlan: { role: "worker" },
      }),
    ).toEqual({ handle: "@Pia", avatarSeed: " hatchling:3", avatarUrl: "/pia.png", agentId: "agent-1", displayName: "Pia" });
    // Never trimmed into a stamp: a seed with a space is a legacy seed on both sides.
    const spaced = resolveAiFace(aiFaceIdentityFromMetadata({ agent: { handle: "pia", avatarSeed: " hatchling:3" } })!);
    expect(spaced).toMatchObject({ kind: "hatchling", reason: "legacy" });
  });

  it("reads only strings, and nothing from a row that names no AI", () => {
    expect(aiFaceIdentityFromMetadata({ agent: { handle: "pia", id: 7, avatarSeed: null } })).toEqual({
      handle: "pia",
      avatarSeed: null,
      avatarUrl: null,
      agentId: null,
      displayName: null,
    });
    expect(aiFaceIdentityFromMetadata({ agent: { avatarSeed: "hatchling:5" } })).toMatchObject({ avatarSeed: "hatchling:5" });
    for (const metadata of [null, undefined, "octo", [], {}, { agent: null }, { agent: [] }, { agent: {} }, { agent: { handle: " ", displayName: "Pia" } }]) {
      expect(aiFaceIdentityFromMetadata(metadata), JSON.stringify(metadata)).toBeNull();
    }
  });
});

describe("aiFaceKey and sameFace", () => {
  it("keys an entry by its agent id, else its handle and seed", () => {
    expect(aiFaceKey({ agentId: " agent-1 ", handle: "pia", avatarSeed: "hatchling:2" })).toBe("agent:agent-1");
    expect(aiFaceKey({ agentId: "agent-1", handle: "renamed" })).toBe(aiFaceKey({ agentId: "agent-1", handle: "pia" }));
    expect(aiFaceKey({ handle: "@Reading_List", avatarSeed: "hatchling:2" })).toBe("handle:reading_list|hatchling:2");
    // Two lanes that share a handle but wear different stamps stay two entries.
    expect(aiFaceKey({ handle: "reading_list", avatarSeed: "hatchling:2" })).not.toBe(
      aiFaceKey({ handle: "reading_list", avatarSeed: "hatchling:5" }),
    );
    expect(aiFaceKey({ agentId: " ", handle: "pia" })).toBe("handle:pia|");
  });

  it("matches faces that look the same, wherever their number came from", () => {
    const stamp = resolveAiFace({ handle: "x", avatarSeed: "hatchling:2" });
    const legacy = resolveAiFace({ handle: "pia" });
    expect(legacy).toMatchObject({ kind: "hatchling", n: 2, reason: "legacy" });
    expect(sameFace(stamp, legacy)).toBe(true);
    expect(sameFace(stamp, resolveAiFace({ handle: "x", avatarSeed: "hatchling:3" }))).toBe(false);
    expect(sameFace({ kind: "octo" }, resolveAiFace({ handle: "ai" }))).toBe(true);
    expect(sameFace({ kind: "unknown" }, resolveAiFace({ handle: "ben", textOnly: true }))).toBe(true);
    expect(sameFace({ kind: "unknown" }, { kind: "octo" })).toBe(false);
    expect(sameFace({ kind: "unknown" }, stamp)).toBe(false);
    const picture = resolveAiFace({ handle: "pia", avatarSeed: "/pia.png" });
    expect(sameFace(picture, resolveAiFace({ handle: "ben", avatarUrl: " /pia.png " }))).toBe(true);
    expect(sameFace(picture, resolveAiFace({ handle: "pia", avatarSeed: "/other.png" }))).toBe(false);
    // A picture is not the face behind it.
    expect(picture.kind === "picture" && sameFace(picture, picture.fallback)).toBe(false);
  });
});

describe("hatchlingSeed", () => {
  it("writes exactly the stamp the resolver reads", () => {
    for (const n of HATCHLINGS) {
      expect(hatchlingSeed(n)).toBe(`hatchling:${n}`);
      expect(resolveAiFace({ handle: "pia", avatarSeed: hatchlingSeed(n) })).toEqual({ kind: "hatchling", n, reason: "stamp" });
    }
  });
});

describe("stackAiFaces", () => {
  it("draws each face once and in order, folding a repeat into the count", () => {
    const octo = { handle: "octo" };
    const ben = { handle: "ben" };
    // reviewer hashes to 3, as ben does: two AIs, one face.
    const reviewer = { handle: "reviewer" };
    const five = { handle: "x", avatarSeed: "hatchling:5" };
    const alsoFive = { handle: "y", avatarSeed: "hatchling:5" };
    const entries = [octo, ben, reviewer, five, alsoFive];
    expect(stackAiFaces(entries, (entry) => entry, 5)).toEqual({ shown: [octo, ben, five], more: 2 });
    expect(stackAiFaces(entries, (entry) => entry, 2)).toEqual({ shown: [octo, ben], more: 3 });
    expect(stackAiFaces([ben, octo], (entry) => entry, 3)).toEqual({ shown: [ben, octo], more: 0 });
    expect(stackAiFaces([], (entry: AiFaceIdentity) => entry, 3)).toEqual({ shown: [], more: 0 });
  });

  it("folds the same picture, and the hollow face, but never a picture into the face behind it", () => {
    const picture = { handle: "pia", avatarSeed: "/pia.png" };
    const samePicture = { handle: "pia2", avatarUrl: "/pia.png" };
    const unknown = { handle: "zed", textOnly: true };
    const alsoUnknown = { handle: "kim", textOnly: true };
    const behindPicture = { handle: "pia" };
    expect(stackAiFaces([picture, samePicture, unknown, alsoUnknown, behindPicture], (entry) => entry, 5).shown).toEqual([
      picture,
      unknown,
      behindPicture,
    ]);
  });
});

describe("withSavedAgentFace", () => {
  const saved = new Map([["agent-pia", { avatarSeed: "hatchling:7" }]]);

  it("draws the viewer's saved agent from its current profile, by its exact id", () => {
    // A row stamped before the owner picked the face again.
    const stamped = { handle: "pia", agentId: " agent-pia ", avatarSeed: "hatchling:2" };
    expect(resolveAiFace(withSavedAgentFace(stamped, saved))).toEqual({ kind: "hatchling", n: 7, reason: "stamp" });
    // The profile decides it all: no stale picture, and it is known, not text-only.
    expect(withSavedAgentFace({ handle: "pia", agentId: "agent-pia", avatarUrl: "/old.png", textOnly: true }, saved)).toEqual({
      handle: "pia",
      agentId: "agent-pia",
      avatarSeed: "hatchling:7",
      avatarUrl: null,
      textOnly: false,
    });
    const withPicture = new Map([["agent-pia", { avatarSeed: "https://images.example/pia.png" }]]);
    expect(resolveAiFace(withSavedAgentFace(stamped, withPicture))).toMatchObject({ kind: "picture", src: "https://images.example/pia.png" });
  });

  it("leaves everyone else as stamped: another person's agent, a helper, a handle", () => {
    for (const identity of [
      { handle: "pia", agentId: "peer-pia", avatarSeed: "hatchling:2" },
      { handle: "pia", avatarSeed: "hatchling:4" },
      { handle: "pia", textOnly: true },
      { handle: "pia", agentId: " " },
    ]) {
      expect(withSavedAgentFace(identity, saved), JSON.stringify(identity)).toBe(identity);
    }
  });
});
