// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeSidebarOrgUser,
  readCachedControllerOrgs,
  readSidebarOrgSnapshot,
  sidebarOrgSnapshotStorageKey,
  sidebarTeamRailExpected,
  writeSidebarOrgSnapshot,
} from "../sidebarOrgSnapshot";

const USER = "member@instafy.dev";
const OTHER_USER = "someone-else@instafy.dev";
const KEY = `instafy:sidebar-orgs:v1:${USER}`;

const ORGS = [
  { id: "org-a", slug: "alpha", name: "Alpha", avatarUrl: "https://cdn/a.png", role: "admin" },
  { id: "org-b", slug: "beta", name: "Beta", avatarUrl: null, role: "builder" },
];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("sidebarOrgSnapshot storage key", () => {
  it("keys per user and normalizes casing/whitespace", () => {
    expect(sidebarOrgSnapshotStorageKey(USER)).toBe(KEY);
    expect(sidebarOrgSnapshotStorageKey("  Member@Instafy.dev ")).toBe(KEY);
    expect(sidebarOrgSnapshotStorageKey(null)).toBeNull();
    expect(sidebarOrgSnapshotStorageKey("   ")).toBeNull();
    expect(normalizeSidebarOrgUser(undefined)).toBeNull();
  });
});

describe("writeSidebarOrgSnapshot", () => {
  it("persists only the fields the rail renders, after a successful fetch", () => {
    writeSidebarOrgSnapshot(USER, ORGS, 3);

    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    expect(stored).toEqual({
      user: USER,
      orgs: [
        { id: "org-a", name: "Alpha", slug: "alpha", avatarUrl: "https://cdn/a.png" },
        { id: "org-b", name: "Beta", slug: "beta", avatarUrl: null },
      ],
      railChipCount: 3,
    });
    // The server's `role` is not rail data and must not be persisted.
    expect(Object.keys(stored.orgs[0])).not.toContain("role");
  });

  it("caps the stored array and the chip count", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `org-${index}`,
      slug: `slug-${index}`,
      name: `Org ${index}`,
      avatarUrl: null,
    }));

    writeSidebarOrgSnapshot(USER, many, 5000);

    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    expect(stored.orgs).toHaveLength(24);
    expect(stored.railChipCount).toBe(99);
  });

  it("writes nothing when there is no signed-in user", () => {
    writeSidebarOrgSnapshot(null, ORGS, 3);
    expect(window.localStorage.length).toBe(0);
  });

  it("swallows quota errors", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };
    try {
      expect(() => writeSidebarOrgSnapshot(USER, ORGS, 3)).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("readSidebarOrgSnapshot", () => {
  it("hydrates a matching snapshot round-trip", () => {
    writeSidebarOrgSnapshot(USER, ORGS, 3);

    const snapshot = readSidebarOrgSnapshot(USER);
    expect(snapshot?.user).toBe(USER);
    expect(snapshot?.railChipCount).toBe(3);
    expect(readCachedControllerOrgs(USER)).toEqual([
      { id: "org-a", slug: "alpha", name: "Alpha", avatarUrl: "https://cdn/a.png" },
      { id: "org-b", slug: "beta", name: "Beta", avatarUrl: null },
    ]);
    expect(sidebarTeamRailExpected(USER)).toBe(true);
  });

  it("matches case-insensitively so the same person keeps their rail", () => {
    writeSidebarOrgSnapshot("Member@Instafy.dev", ORGS, 2);
    expect(readCachedControllerOrgs(USER)).toHaveLength(2);
  });

  it("ignores a snapshot belonging to a different user", () => {
    writeSidebarOrgSnapshot(USER, ORGS, 3);

    expect(readSidebarOrgSnapshot(OTHER_USER)).toBeNull();
    expect(readCachedControllerOrgs(OTHER_USER)).toEqual([]);
    expect(sidebarTeamRailExpected(OTHER_USER)).toBe(false);
  });

  it("ignores a snapshot whose payload names a different owner than its key", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ user: OTHER_USER, orgs: ORGS, railChipCount: 3 }),
    );

    expect(readSidebarOrgSnapshot(USER)).toBeNull();
    expect(readCachedControllerOrgs(USER)).toEqual([]);
  });

  it("falls back cleanly on malformed JSON", () => {
    window.localStorage.setItem(KEY, "{not json at all");

    expect(() => readSidebarOrgSnapshot(USER)).not.toThrow();
    expect(readSidebarOrgSnapshot(USER)).toBeNull();
    expect(readCachedControllerOrgs(USER)).toEqual([]);
    expect(sidebarTeamRailExpected(USER)).toBe(false);
  });

  it("falls back cleanly on structurally wrong payloads", () => {
    for (const raw of ["[]", '"nope"', "null", "42"]) {
      window.localStorage.setItem(KEY, raw);
      expect(readSidebarOrgSnapshot(USER)).toBeNull();
      expect(readCachedControllerOrgs(USER)).toEqual([]);
    }
  });

  it("drops individual malformed org entries and bad counts", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        user: USER,
        orgs: [
          { id: "org-a", name: "Alpha", slug: "alpha", avatarUrl: null },
          { id: 42, name: "Numeric id" },
          { name: "No id" },
          null,
          "nope",
        ],
        railChipCount: "three",
      }),
    );

    const snapshot = readSidebarOrgSnapshot(USER);
    expect(snapshot?.orgs).toEqual([
      { id: "org-a", name: "Alpha", slug: "alpha", avatarUrl: null },
    ]);
    expect(snapshot?.railChipCount).toBe(0);
    expect(sidebarTeamRailExpected(USER)).toBe(false);
  });

  it("returns nothing when there is no cache entry at all", () => {
    expect(readSidebarOrgSnapshot(USER)).toBeNull();
    expect(readCachedControllerOrgs(USER)).toEqual([]);
    expect(sidebarTeamRailExpected(USER)).toBe(false);
  });

  it("survives localStorage being unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("SecurityError");
      },
    });
    try {
      expect(readSidebarOrgSnapshot(USER)).toBeNull();
      expect(readCachedControllerOrgs(USER)).toEqual([]);
      expect(() => writeSidebarOrgSnapshot(USER, ORGS, 3)).not.toThrow();
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    }
  });
});
