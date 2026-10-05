import { describe, expect, it } from "vitest";
import type { OriginError, RevertWorkspaceGitCommitResult } from "../../../../sdk/instafy";
import type { OriginPublishReport } from "../../../../services/runtimeController/originErrors";
import { REVERT_ROUTE_UNAVAILABLE_MESSAGE } from "../../../../services/runtimeController/workspaceGit";
import {
  DESKTOP_UNREACHABLE_COPY,
  describeChangeRevertOutcome,
  describeFileNotSaved,
  describeRevertConfirm,
  describeSaveFailure,
  DISMISSAL_NOT_APPLIED_COPY,
  FETCH_PENDING_COPY,
  formatPathList,
  keptOnComputerCopy,
  LEASE_CONFLICT_COPY,
  MAIN_BUSY_COPY,
  rejectedPathCopy,
  REVERT_CONFLICT_COPY,
  REVERT_DIALOG,
  revertFailureCopy,
  revertSuccessCopy,
  SAVE_COPY,
  sharedOriginErrorCopy,
  STATELESS_UNREACHABLE_COPY,
} from "../versioningCopy";

// The sentences Save in Files, History and the chat change card share are
// written once: each surface says the same thing for the same answer.

function originError(patch: Partial<OriginError>): OriginError {
  return { status: 409, message: "refused", routeUnavailable: false, ...patch };
}

function revertFailure(status: number, code?: string, patch: Partial<OriginError> = {}): RevertWorkspaceGitCommitResult {
  return {
    ok: false,
    conflict: status === 409,
    code,
    errorInfo: originError({ status, code, ...patch }),
  };
}

const saveMessage = (patch: Partial<OriginError>, operation: "save" | "delete" = "save") =>
  describeSaveFailure({ error: originError(patch), mode: "stateless", label: "a.md", operation }).message;
const historyMessage = (patch: Partial<OriginError>, origin: "stateless" | "desktop" = "stateless") =>
  sharedOriginErrorCopy(originError(patch), origin);
const historyRevertMessage = (status: number, code?: string, patch: Partial<OriginError> = {}) =>
  revertFailureCopy(revertFailure(status, code, patch), "stateless").text;
const cardRevertMessage = (status: number, code?: string, patch: Partial<OriginError> = {}) =>
  describeChangeRevertOutcome(revertFailure(status, code, patch)).message;

const notSavedReport: OriginPublishReport = {
  rev: null,
  baseRev: null,
  localRev: null,
  gitSyncStatus: "unpublished",
  recoveryRef: null,
  recoveryRefs: [],
  conflictedPaths: [],
  rejectedPaths: [],
  checkoutMoved: false,
  unpushedRefs: 0,
  failure: null,
  retryable: true,
};

describe("versioning copy shared across surfaces", () => {
  it("says the same busy, lease, loading and Desktop dismissal sentences everywhere", () => {
    for (const [code, status, sentence] of [
      ["main_busy", 409, MAIN_BUSY_COPY],
      ["lease_conflict", 409, LEASE_CONFLICT_COPY],
      ["fetch_pending", 503, FETCH_PENDING_COPY],
    ] as const) {
      expect(saveMessage({ code, status })).toBe(sentence);
      expect(historyMessage({ code, status })).toBe(sentence);
      expect(historyRevertMessage(status, code)).toBe(sentence);
      expect(cardRevertMessage(status, code)).toBe(sentence);
    }
    expect(saveMessage({ code: "dismissal_not_applied", status: 422 })).toBe(DISMISSAL_NOT_APPLIED_COPY);
    expect(historyMessage({ code: "dismissal_not_applied", status: 422 })).toBe(DISMISSAL_NOT_APPLIED_COPY);
  });

  it("reads a 503 without a code as unreachable on every surface", () => {
    expect(saveMessage({ status: 503 })).toBe(SAVE_COPY.statelessUnreachable);
    expect(saveMessage({ status: 503 }, "delete")).toBe(STATELESS_UNREACHABLE_COPY);
    expect(historyMessage({ status: 503 })).toBe(STATELESS_UNREACHABLE_COPY);
    expect(historyMessage({ status: 503 }, "desktop")).toBe(DESKTOP_UNREACHABLE_COPY);
    expect(historyRevertMessage(503)).toBe(STATELESS_UNREACHABLE_COPY);
    expect(cardRevertMessage(503)).toBe(STATELESS_UNREACHABLE_COPY);
    // Only the coded answer means the space is still loading.
    expect(historyMessage({ status: 503, code: "fetch_pending" })).toBe(FETCH_PENDING_COPY);
  });

  it("reads a refused push or a stopping workspace as unreachable in History too", () => {
    for (const code of ["push_rejected", "workspace_stopping", "canonical_unreachable", "token_unavailable"]) {
      expect(historyMessage({ status: 409, code })).toBe(STATELESS_UNREACHABLE_COPY);
      expect(saveMessage({ status: 409, code }, "delete")).toBe(STATELESS_UNREACHABLE_COPY);
      expect(cardRevertMessage(409, code)).toBe(STATELESS_UNREACHABLE_COPY);
    }
  });

  it("names a Desktop publish failure the same way in Files and History", () => {
    const failed = { status: 503, code: "not_saved", report: { ...notSavedReport, failure: "the remote refused the push." } };
    const expected = "Not saved: the remote refused the push. The work is kept under History, in Unsaved work.";
    expect(historyMessage(failed, "desktop")).toBe(expected);
    expect(
      describeSaveFailure({ error: originError(failed), mode: "desktop", label: "a.md", unsavedWorkVisible: true }).message,
    ).toBe(expected);
    // Without a cause from the origin, neither surface invents one.
    const silent = { status: 503, code: "not_saved", message: "", report: notSavedReport };
    expect(historyMessage(silent, "desktop")).toBe("Not saved. The work is kept under History, in Unsaved work.");
    expect(
      describeSaveFailure({ error: originError(silent), mode: "desktop", label: "a.md", unsavedWorkVisible: true }).message,
    ).toBe("Not saved. The work is kept under History, in Unsaved work.");
  });

  it("words a revert the same in History and on the chat card", () => {
    expect(describeRevertConfirm([])).toBe(REVERT_DIALOG.body);
    expect(describeChangeRevertOutcome({ ok: true, rev: "c".repeat(40) }).message).toBe(revertSuccessCopy(true));
    expect(describeChangeRevertOutcome({ ok: true, rev: "c".repeat(40), committed: false }).message).toBe(
      revertSuccessCopy(false),
    );
    expect(historyRevertMessage(409, "revert_conflict")).toBe(REVERT_CONFLICT_COPY);
    expect(cardRevertMessage(409, "revert_conflict")).toBe(REVERT_CONFLICT_COPY);
    const dirty = { paths: ["a.md", "b.md"] };
    expect(historyRevertMessage(409, "dirty_paths", dirty)).toBe(
      "Files on this computer have edits this revert would change: a.md and b.md. Save them first.",
    );
    expect(cardRevertMessage(409, "dirty_paths", dirty)).toBe(historyRevertMessage(409, "dirty_paths", dirty));
    const routeMissing: RevertWorkspaceGitCommitResult = {
      ok: false,
      conflict: false,
      routeUnavailable: true,
      errorInfo: originError({ status: 404, message: "origin path not found", routeUnavailable: true }),
    };
    expect(revertFailureCopy(routeMissing, "stateless").text).toBe(REVERT_ROUTE_UNAVAILABLE_MESSAGE);
    expect(describeChangeRevertOutcome(routeMissing).message).toBe(REVERT_ROUTE_UNAVAILABLE_MESSAGE);
  });

  it("states each file rule once", () => {
    const placement = { unsavedWorkInHistory: true };
    expect(describeFileNotSaved({ reason: "too_large", keptSavedVersion: false }, placement)).toBe(rejectedPathCopy("too_large").message);
    expect(describeFileNotSaved({ reason: "policy", keptSavedVersion: false }, placement)).toBe(rejectedPathCopy("policy").message);
    expect(rejectedPathCopy("ignored").message.startsWith(describeFileNotSaved({ reason: "ignored", keptSavedVersion: false }, placement))).toBe(
      true,
    );
    // The Desktop line's clause and the chat card's sentence are one rule.
    expect(keptOnComputerCopy([{ path: ".env", reason: "secret", keptSavedVersion: false }])).toEqual([
      ".env stays on this computer: secret files aren't saved to the space.",
    ]);
    expect(describeFileNotSaved({ reason: "secret", keptSavedVersion: false }, placement)).toBe(
      "Secret files aren't saved to the space. Use Secrets for these values.",
    );
    expect(cardRevertMessage(422, "excluded_path", { reason: "secret" })).toBe(
      "This change can't be reverted here. Secret files aren't saved to the space. Ask the agent to undo it.",
    );
  });

  it("lists paths one way", () => {
    expect(formatPathList([])).toBe("");
    expect(formatPathList(["a"])).toBe("a");
    expect(formatPathList(["a", "b"])).toBe("a and b");
    expect(formatPathList(["a", "b", "c"])).toBe("a, b and c");
    expect(formatPathList(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
    expect(formatPathList(["a", "a", " ", "b"])).toBe("a and b");
  });
});
