// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectRecencyStorageKey, mostRecentProjectId, readProjectRecency, recordProjectOpened } from "../projectRecency";

const account = "reader@example.test";
const key = getProjectRecencyStorageKey(account)!;

describe("project recency storage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("preserves the legacy API while isolating normalized account history", () => {
    recordProjectOpened("legacy", 10);
    recordProjectOpened("first", 20, " READER@EXAMPLE.TEST ");
    recordProjectOpened("other", 30, "other@example.test");
    expect(readProjectRecency()).toEqual({ legacy: 10 });
    expect(readProjectRecency(account)).toEqual({ first: 20 });
    expect(readProjectRecency("other@example.test")).toEqual({ other: 30 });
    expect(readProjectRecency("new@example.test")).toEqual({});
    expect(mostRecentProjectId(["legacy", "first"], readProjectRecency(account))).toBe("first");
    expect(mostRecentProjectId(["missing"])).toBeNull();
  });

  it("does not read, migrate or write history without an explicit valid account", () => {
    recordProjectOpened("legacy", 10);
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    for (const invalid of [null, "", "   ", "x".repeat(321), "\ud800"]) {
      expect(readProjectRecency(invalid)).toEqual({});
      recordProjectOpened("space", 20, invalid);
    }
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(readProjectRecency(account)).toEqual({});
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["broken", "null", "[]", "42", '"string"', " ".repeat(131_073)])("ignores invalid or oversized storage %#", (value) => {
    window.localStorage.setItem(key, value);
    expect(readProjectRecency(account)).toEqual({});
  });

  it("keeps only finite timestamps with bounded project IDs", () => {
    window.localStorage.setItem(key, '{"valid":100,"infinite":1e309,"string":"100","null":null,"":4,"\\u0000":5}');
    expect(readProjectRecency(account)).toEqual({ valid: 100 });
    const set = vi.spyOn(Storage.prototype, "setItem");
    for (const at of [NaN, Infinity, -Infinity]) recordProjectOpened("invalid", at, account);
    for (const id of ["", " ", "x".repeat(257), "invalid\n"]) recordProjectOpened(id, 50, account);
    expect(set).not.toHaveBeenCalled();
  });

  it("bounds both reads and persisted writes to the latest 200 entries", () => {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(Array.from({ length: 230 }, (_, i) => [`space-${i}`, i]))));
    const read = readProjectRecency(account);
    expect(Object.keys(read)).toHaveLength(200);
    expect(read["space-29"]).toBeUndefined();
    expect(read["space-30"]).toBe(30);
    recordProjectOpened("newest", 300, account);
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    expect(Object.keys(saved)).toHaveLength(200);
    expect(saved["space-30"]).toBeUndefined();
    expect(saved.newest).toBe(300);
    recordProjectOpened("space-31", 400, account);
    expect(mostRecentProjectId(["newest", "space-31"], readProjectRecency(account))).toBe("space-31");
  });

  it("handles reserved object-property names without changing the object prototype", () => {
    recordProjectOpened("__proto__", 10, account);
    expect(Object.getPrototypeOf(readProjectRecency(account))).toBe(Object.prototype);
    expect(Object.hasOwn(readProjectRecency(account), "__proto__")).toBe(true);
  });

  it("tolerates storage getters, reads and writes being unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(readProjectRecency(account)).toEqual({});
    expect(() => recordProjectOpened("space", 10, account)).not.toThrow();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("denied"); });
    expect(readProjectRecency(account)).toEqual({});
    expect(() => recordProjectOpened("space", 10, account)).not.toThrow();
  });
});
