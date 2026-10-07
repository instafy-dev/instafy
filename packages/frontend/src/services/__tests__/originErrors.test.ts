import { describe, expect, it } from "vitest";
import {
  isOriginAutoRetryCode,
  isOriginRetryLaterCode,
  originAutoRetryDelayMs,
  originErrorFromException,
  parseOriginError,
  redactLeaseHolder,
  parseOriginErrorText,
  parsePublishReport,
  parseRetryAfterMs,
} from "../runtimeController/originErrors";

function json(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("parseOriginError: 409 codes", () => {
  it.each([
    ["head_moved", { head: "e1", paths: ["README.md"] }],
    ["path_type_conflict", { head: "e2", paths: ["docs"] }],
    ["restore_conflict", { head: "e3", paths: ["a.txt", "b.txt"] }],
  ])("%s keeps head and paths", async (code, extra) => {
    const error = await parseOriginError(json(409, { error: "conflict", code, ...extra }));
    expect(error).toMatchObject({ status: 409, code, head: extra.head, paths: extra.paths, routeUnavailable: false });
  });

  it.each(["revert_conflict", "dirty_paths"])("%s keeps paths", async (code) => {
    const error = await parseOriginError(json(409, { error: "x", code, paths: ["src/a.ts"] }));
    expect(error).toMatchObject({ status: 409, code, paths: ["src/a.ts"] });
    expect(error.head).toBeUndefined();
  });

  it.each([
    "main_busy",
    "rev_not_on_main",
    "idempotency_conflict",
    "recovery_ref_moved",
  ])("%s is carried as the code", async (code) => {
    const error = await parseOriginError(json(409, { error: "refused", code }));
    expect(error).toMatchObject({ status: 409, code, message: "refused", routeUnavailable: false });
  });

  it("not_saved carries the publish report and its conflicted paths", async () => {
    const error = await parseOriginError(
      json(409, {
        error: "Not saved: push rejected (kept at refs/instafy/recovery/o/n)",
        code: "not_saved",
        rev: null,
        baseRev: "b",
        localRev: "l",
        gitSyncStatus: "unpublished",
        recoveryRef: "refs/instafy/recovery/o/n",
        recoveryRefs: [{ name: "n", kind: "unpublished", rev: "r", reference: "refs/instafy/recovery/o/n", pushed: true, created: true }],
        conflictedPaths: ["a.md"],
        rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
        checkoutMoved: false,
        unpushedRefs: 0,
        failure: "push rejected",
      }),
    );
    expect(error.code).toBe("not_saved");
    expect(error.paths).toEqual(["a.md"]);
    expect(error.report).toMatchObject({
      gitSyncStatus: "unpublished",
      recoveryRef: "refs/instafy/recovery/o/n",
      conflictedPaths: ["a.md"],
      rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
      failure: "push rejected",
      retryable: false,
    });
    expect(error.report?.recoveryRefs[0]).toMatchObject({ reference: "refs/instafy/recovery/o/n", pushed: true });
  });

  it("maps the controller's lease refusal without keeping the holder id", async () => {
    const error = await parseOriginError(
      json(409, { message: "project currently leased by 0f8b2c1e-1111-4222-8333-444455556666 until 2026-10-04T10:00:00Z" }),
    );
    expect(error.code).toBe("lease_conflict");
    expect(error.status).toBe(409);
    expect(JSON.stringify(error)).not.toContain("0f8b2c1e");
  });

  it("leaves a plain 409 without a code", () => {
    const error = parseOriginErrorText(409, JSON.stringify({ error: "workspace is already mutating" }));
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("workspace is already mutating");
  });
});

describe("parseOriginError: 422 codes", () => {
  it("excluded_path keeps the reason", async () => {
    const error = await parseOriginError(json(422, { error: "secret", code: "excluded_path", paths: [".env"], reason: "secret" }));
    expect(error).toMatchObject({ status: 422, code: "excluded_path", paths: [".env"], reason: "secret" });
  });

  it("excluded_path without a reason", async () => {
    const error = await parseOriginError(json(422, { error: "excluded", code: "excluded_path", paths: ["node_modules/x.js"] }));
    expect(error.reason).toBeUndefined();
    expect(error.paths).toEqual(["node_modules/x.js"]);
  });

  it("ignored_path", async () => {
    const error = await parseOriginError(json(422, { error: "ignored", code: "ignored_path", paths: ["dist/app.js"] }));
    expect(error).toMatchObject({ code: "ignored_path", paths: ["dist/app.js"] });
  });

  it("policy_rejected keeps the reason", async () => {
    const error = await parseOriginError(json(422, { error: "too big", code: "policy_rejected", paths: ["video.mp4"], reason: "too_large" }));
    expect(error).toMatchObject({ code: "policy_rejected", reason: "too_large" });
  });

  it("dismissal_not_applied keeps retryable", async () => {
    const error = await parseOriginError(json(422, { error: "dismissed work is still on the branch", code: "dismissal_not_applied", retryable: false }));
    expect(error).toMatchObject({ code: "dismissal_not_applied", retryable: false });
    expect(error.report).toBeUndefined();
  });
});

describe("parseOriginError: other statuses", () => {
  it.each(["unsupported_entry", "delete_requires_base_rev", "not_supported", "invalid_ref", "invalid_rev"])(
    "400 %s",
    (code) => {
      expect(parseOriginErrorText(400, JSON.stringify({ error: "bad", code })).code).toBe(code);
    },
  );

  it("413 without a body is too_large", () => {
    expect(parseOriginErrorText(413, "").code).toBe("too_large");
  });

  it("503 fetch_pending reads Retry-After", async () => {
    const error = await parseOriginError(json(503, { error: "fetching", code: "fetch_pending" }, { "retry-after": "3" }));
    expect(error).toMatchObject({ code: "fetch_pending", retryAfterMs: 3000 });
  });

  // The stateless gateway's other 503 answers: `{error, code}` and
  // `Retry-After: 2`, exactly as `OriginError::RetryLater` writes them.
  it.each([
    ["writes_busy", "the server is busy saving other changes; try again in a moment"],
    ["mirror_reset", "this space's copy on the server was damaged and is being made again; try again in a moment"],
    ["disk_full", "the server is out of disk space; try again in a moment"],
  ])("503 %s reads its code and Retry-After", async (code, message) => {
    const error = await parseOriginError(json(503, { error: message, code }, { "retry-after": "2" }));
    expect(error).toEqual({ status: 503, code, message, retryAfterMs: 2000, routeUnavailable: false });
  });

  it("a 503 code without Retry-After has no wait", () => {
    const error = parseOriginErrorText(503, JSON.stringify({ error: "busy", code: "writes_busy" }));
    expect(error.code).toBe("writes_busy");
    expect(error).not.toHaveProperty("retryAfterMs");
  });

  it("workspace_stopping keeps retryable", () => {
    const error = parseOriginErrorText(503, JSON.stringify({ error: "stopping", code: "workspace_stopping", retryable: true }));
    expect(error).toMatchObject({ code: "workspace_stopping", retryable: true });
  });

  it("a plain-text body becomes the message", () => {
    expect(parseOriginErrorText(500, "boom").message).toBe("boom");
  });
});

describe("routeUnavailable", () => {
  it("is set for the controller proxy's unknown-route 404 (controller error shape)", () => {
    expect(parseOriginErrorText(404, JSON.stringify({ message: "origin path not found" })).routeUnavailable).toBe(true);
  });

  it("is set for the origin-style body too", () => {
    expect(parseOriginErrorText(404, JSON.stringify({ error: "origin path not found" })).routeUnavailable).toBe(true);
  });

  it("is set for an empty 404 (an origin without the route)", () => {
    expect(parseOriginErrorText(404, "").routeUnavailable).toBe(true);
  });

  it("is not set for coded 404s or other messages", () => {
    expect(parseOriginErrorText(404, JSON.stringify({ error: "no such rev", code: "rev_not_found" })).routeUnavailable).toBe(false);
    expect(parseOriginErrorText(404, JSON.stringify({ error: "file not found" })).routeUnavailable).toBe(false);
  });
});

describe("parsePublishReport", () => {
  it("returns null for responses without report fields (old and stateless gateways)", () => {
    expect(parsePublishReport({ rev: "a" })).toBeNull();
    expect(parsePublishReport({ rev: "a", baseRev: "b", committed: true })).toBeNull();
    expect(parsePublishReport(null)).toBeNull();
  });

  it("parses a partial publish with snake_case fallbacks and unknown statuses", () => {
    expect(
      parsePublishReport({
        rev: "p",
        base_rev: "r",
        git_sync_status: "partial",
        conflicted_paths: ["a"],
        rejected_paths: [{ path: "b", reason: "too_large", kept_saved_version: true }],
        unpushed_refs: 2,
        retryable: true,
      }),
    ).toMatchObject({
      rev: "p",
      baseRev: "r",
      gitSyncStatus: "partial",
      conflictedPaths: ["a"],
      rejectedPaths: [{ path: "b", reason: "too_large", keptSavedVersion: true }],
      unpushedRefs: 2,
      retryable: true,
      checkoutMoved: false,
    });
    expect(parsePublishReport({ gitSyncStatus: "later" })?.gitSyncStatus).toBeNull();
  });
});

describe("helpers", () => {
  it("parses Retry-After as seconds or a date", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("Sat, 04 Oct 2026 10:00:02 GMT", Date.parse("Sat, 04 Oct 2026 10:00:00 GMT"))).toBe(2000);
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("maps exceptions to network and timeout errors", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(originErrorFromException(abort)).toMatchObject({ status: 0, code: "timeout" });
    expect(originErrorFromException(new TypeError("Failed to fetch"))).toMatchObject({
      status: 0,
      code: "network_error",
      message: "Failed to fetch",
    });
  });
});

describe("answers that say to try again later", () => {
  const budget = { defaultDelayMs: 1500, maxDelayMs: 5000 };

  it("knows the four 503 codes and retries only the three that clear by themselves", () => {
    for (const code of ["fetch_pending", "writes_busy", "mirror_reset", "disk_full"]) {
      expect(isOriginRetryLaterCode(code)).toBe(true);
    }
    expect(["fetch_pending", "writes_busy", "mirror_reset"].every(isOriginAutoRetryCode)).toBe(true);
    expect(isOriginAutoRetryCode("disk_full")).toBe(false);
    for (const code of ["main_busy", "canonical_unreachable", "workspace_stopping", "", null, undefined]) {
      expect(isOriginRetryLaterCode(code)).toBe(false);
      expect(isOriginAutoRetryCode(code)).toBe(false);
    }
  });

  it.each(["fetch_pending", "writes_busy", "mirror_reset"])("%s waits for Retry-After within the budget", (code) => {
    expect(originAutoRetryDelayMs({ code, retryAfterMs: 2000 }, budget)).toBe(2000);
    expect(originAutoRetryDelayMs({ code, retryAfterMs: 0 }, budget)).toBe(0);
    expect(originAutoRetryDelayMs({ code, retryAfterMs: 60_000 }, budget)).toBe(5000);
    expect(originAutoRetryDelayMs({ code }, budget)).toBe(1500);
    expect(originAutoRetryDelayMs({ code, retryAfterMs: Number.NaN }, budget)).toBe(1500);
    expect(originAutoRetryDelayMs({ code, retryAfterMs: -1 }, budget)).toBe(1500);
  });

  it("never retries disk_full or any other answer on its own", () => {
    expect(originAutoRetryDelayMs({ code: "disk_full", retryAfterMs: 2000 }, budget)).toBeNull();
    expect(originAutoRetryDelayMs({ code: "main_busy", retryAfterMs: 2000 }, budget)).toBeNull();
    expect(originAutoRetryDelayMs({ retryAfterMs: 2000 }, budget)).toBeNull();
    expect(originAutoRetryDelayMs(null, budget)).toBeNull();
    expect(originAutoRetryDelayMs(undefined, budget)).toBeNull();
  });
});

describe("redactLeaseHolder", () => {
  it("drops the holder and keeps the rest", () => {
    expect(redactLeaseHolder("project currently leased by 0f8b2c1e-1111-4222-8333-444455556666 until 2026-10-04T10:00:00Z")).toBe(
      "project currently leased by another session until 2026-10-04T10:00:00Z",
    );
    expect(redactLeaseHolder("currently leased by someone")).toBe("currently leased by another session");
    expect(redactLeaseHolder("db down")).toBe("db down");
  });
});
