import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OriginError } from "../../../../sdk/instafy";
import {
  describeSaveFailure,
  rejectedPathCopy,
  rejectedPathsCopy,
  SAVE_COPY,
  staleSaveMessage,
} from "../workspaceSaveCopy";

function error(patch: Partial<OriginError>): OriginError {
  return { status: 409, message: "refused", routeUnavailable: false, ...patch };
}

const describeStateless = (patch: Partial<OriginError>) =>
  describeSaveFailure({ error: error(patch), mode: "stateless", label: "README.md" });

describe("workspace save copy", () => {
  it("raises the stale card and offers Resolve for a moved head", () => {
    for (const code of ["head_moved", "path_type_conflict"]) {
      expect(describeStateless({ code })).toEqual({
        message: '"README.md" changed while you were editing. Your edits are kept.',
        action: { kind: "resolve", label: "Resolve" },
        staleNotice: true,
      });
    }
    expect(staleSaveMessage("a.ts")).toBe('"a.ts" changed while you were editing. Your edits are kept.');
  });

  it("maps busy and lease answers without naming the holder", () => {
    expect(describeStateless({ code: "main_busy" })).toEqual({
      message: SAVE_COPY.mainBusy,
      action: { kind: "retry", label: "Try again" },
    });
    const lease = describeStateless({ code: "lease_conflict", message: "project currently leased by 0f0f until later" });
    expect(lease).toEqual({ message: "The agent is saving right now. Try again in a moment." });
  });

  it("maps every policy refusal to its own sentence", () => {
    expect(describeStateless({ status: 422, code: "ignored_path" })).toEqual({
      message: SAVE_COPY.ignored,
      action: { kind: "open_secrets", label: "Open Secrets" },
    });
    expect(describeStateless({ status: 422, code: "excluded_path", reason: "secret" })).toEqual({
      message: SAVE_COPY.secret,
      action: { kind: "open_secrets", label: "Open Secrets" },
    });
    expect(describeStateless({ status: 422, code: "excluded_path" }).message).toBe(SAVE_COPY.excluded);
    expect(describeStateless({ status: 422, code: "excluded_path", reason: "attachment" }).message).toBe(
      SAVE_COPY.attachment,
    );
    expect(describeStateless({ status: 422, code: "policy_rejected", reason: "too_large" }).message).toBe(
      SAVE_COPY.tooLarge,
    );
    expect(
      describeStateless({ status: 422, code: "policy_rejected", message: "binary files are not allowed." }).message,
    ).toBe("This space's file rules refused the file: binary files are not allowed.");
    expect(describeStateless({ status: 400, code: "unsupported_entry" }).message).toBe(SAVE_COPY.unsupportedEntry);
    expect(describeStateless({ status: 400, code: "delete_requires_base_rev" }).message).toBe(
      "Reload the folder and try again.",
    );
  });

  it("separates an unreachable gateway from an unconnected Desktop folder", () => {
    expect(describeStateless({ status: 502, code: "canonical_unreachable" }).message).toBe(
      SAVE_COPY.statelessUnreachable,
    );
    expect(describeStateless({ status: 0, code: "network_error" }).message).toBe(SAVE_COPY.statelessUnreachable);
    expect(describeStateless({ status: 503, code: "fetch_pending" }).message).toBe(SAVE_COPY.fetchPending);
    expect(
      describeSaveFailure({ error: error({ status: 0, code: "token_unavailable" }), mode: "desktop", label: "a" })
        .message,
    ).toBe("The folder on this computer isn't connected. Your edits are kept here.");
  });

  it("explains Desktop publish refusals", () => {
    const notSaved = describeSaveFailure({
      error: error({
        status: 503,
        code: "not_saved",
        message: "not saved",
        report: {
          rev: null, baseRev: null, localRev: null, gitSyncStatus: "unpublished", recoveryRef: null,
          recoveryRefs: [], conflictedPaths: [], rejectedPaths: [], checkoutMoved: false, unpushedRefs: 0,
          failure: "the remote refused the push.", retryable: true,
        },
      }),
      mode: "desktop",
      label: "a",
    });
    expect(notSaved.message).toBe(
      "Not saved: the remote refused the push. The work is kept under History, in Unsaved work.",
    );
    expect(describeSaveFailure({ error: error({ status: 422, code: "dismissal_not_applied" }), mode: "desktop", label: "a" }).message).toBe(
      SAVE_COPY.dismissalNotApplied,
    );
  });

  it("maps publish rejection reasons", () => {
    expect(rejectedPathCopy("secret").action?.kind).toBe("open_secrets");
    expect(rejectedPathCopy("ignored").message).toBe(SAVE_COPY.ignored);
    expect(rejectedPathCopy("too_large").message).toBe(SAVE_COPY.tooLarge);
    expect(rejectedPathCopy("unsupported").message).toBe(SAVE_COPY.unsupportedEntry);
    expect(rejectedPathCopy(null).message).toBe(SAVE_COPY.excluded);
    expect(
      rejectedPathsCopy(
        [
          { path: "other", reason: "too_large", keptSavedVersion: true },
          { path: ".env", reason: "secret", keptSavedVersion: false },
        ],
        [".env"],
      )?.message,
    ).toBe(SAVE_COPY.secret);
    expect(rejectedPathsCopy([], ["a"])).toBeNull();
  });

  it("falls back to a plain sentence for unknown failures", () => {
    expect(describeStateless({ status: 400, message: "nope" }).message).toBe(
      'Couldn\'t save "README.md". Your edits are kept here.',
    );
  });

  it("keeps the copy free of em dashes", () => {
    const source = readFileSync(fileURLToPath(new URL("../workspaceSaveCopy.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("—");
  });
});
