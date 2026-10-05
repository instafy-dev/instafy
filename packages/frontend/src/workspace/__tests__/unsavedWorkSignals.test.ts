// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { markUnsavedWorkSeen, readUnsavedWorkSeen, unsavedWorkSeenKey } from "../unsavedWorkSeen";
import { collectRecoveryRefs, extractRecoveryRefsFromMetadata } from "../unsavedWorkSignals";

describe("extractRecoveryRefsFromMetadata", () => {
  it("reads recovery refs from apply and refresh artifacts only", () => {
    const metadata = {
      artifacts: [
        { kind: "origin/apply", metadata: { recoveryRef: "refs/instafy/recovery/o/a" } },
        { kind: "origin/refresh", metadata: { recoveryRefs: [{ reference: "refs/instafy/recovery/o/b" }, "refs/instafy/recovery/o/c"] } },
        { kind: "origin/apply-error", metadata: { recoveryRef: "refs/instafy/recovery/o/ignored" } },
        { kind: "origin/apply", metadata: { recoveryRef: null } },
      ],
    };
    expect(extractRecoveryRefsFromMetadata(metadata)).toEqual([
      "refs/instafy/recovery/o/a",
      "refs/instafy/recovery/o/b",
      "refs/instafy/recovery/o/c",
    ]);
    expect(extractRecoveryRefsFromMetadata(null)).toEqual([]);
    expect(extractRecoveryRefsFromMetadata({ artifacts: "nope" })).toEqual([]);
  });

  it("collects a sorted, de-duplicated list across messages", () => {
    const apply = (ref: string) => ({ metadata: { artifacts: [{ kind: "origin/apply", metadata: { recoveryRef: ref } }] } });
    expect(collectRecoveryRefs([apply("b"), { metadata: null }, apply("a"), apply("b")])).toEqual(["a", "b"]);
  });
});

describe("unsaved work seen set", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("is per project and per viewer", () => {
    const key = unsavedWorkSeenKey({ ref: "refs/instafy/recovery/o/a", rev: "1".repeat(40), kind: "unpublished" });
    markUnsavedWorkSeen("p", "user-1", [key]);
    expect(readUnsavedWorkSeen("p", "user-1").has(key)).toBe(true);
    expect(readUnsavedWorkSeen("p", "user-2").has(key)).toBe(false);
    expect(readUnsavedWorkSeen("q", "user-1").has(key)).toBe(false);
    expect(window.localStorage.getItem("instafy.unsavedWork.seen.p.user-1")).toContain(key);
  });

  it("treats a moved ref as new", () => {
    markUnsavedWorkSeen("p", "u", [unsavedWorkSeenKey({ ref: "r", rev: "1", kind: "unpublished" })]);
    expect(readUnsavedWorkSeen("p", "u").has(unsavedWorkSeenKey({ ref: "r", rev: "2", kind: "unpublished" }))).toBe(
      false,
    );
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readUnsavedWorkSeen("p", "u").size).toBe(0);
    expect(() => markUnsavedWorkSeen("p", "u", ["k"])).not.toThrow();
  });
});
