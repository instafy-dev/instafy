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
  desktopSaveFailureCopy,
  DISK_FULL_COPY,
  DISMISSAL_NOT_APPLIED_COPY,
  FETCH_PENDING_COPY,
  historyFailureCopy,
  formatPathList,
  keptOnComputerCopy,
  LEASE_CONFLICT_COPY,
  MAIN_BUSY_COPY,
  MIRROR_RESET_COPY,
  NOTHING_TO_RESTORE_COPY,
  rejectedPathCopy,
  restoreSuccessCopy,
  REVERT_CONFLICT_COPY,
  REVERT_DIALOG,
  revertCheckFailedCopy,
  revertFailureCopy,
  revertSuccessCopy,
  retryLaterCopy,
  SAVE_COPY,
  sharedOriginErrorCopy,
  STATELESS_UNREACHABLE_COPY,
  WRITES_BUSY_COPY,
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

  // The gateway's 503 answers with Retry-After.
  it.each([
    ["writes_busy", WRITES_BUSY_COPY, "The server is busy saving other changes. Try again in a moment."],
    ["mirror_reset", MIRROR_RESET_COPY, "The server is rebuilding its copy of this space. Try again in a moment."],
    ["disk_full", DISK_FULL_COPY, "The space is out of room right now. Try again later."],
  ] as const)("says the same %s sentence on every surface", (code, sentence, text) => {
    expect(sentence).toBe(text);
    expect(retryLaterCopy(code)).toBe(sentence);
    // Deleting, creating a folder or a setting have no edits to keep.
    expect(saveMessage({ code, status: 503 }, "delete")).toBe(sentence);
    expect(historyMessage({ code, status: 503 })).toBe(sentence);
    expect(historyMessage({ code, status: 503 }, "desktop")).toBe(sentence);
    // History's Revert, and Unsaved work's Restore, Remove and file reads.
    expect(historyRevertMessage(503, code)).toBe(sentence);
    expect(historyFailureCopy(originError({ code, status: 503 }), "stateless", "Couldn't restore this work.")).toBe(
      sentence,
    );
    expect(desktopSaveFailureCopy(originError({ code, status: 503 }))).toBe(sentence);
    // The chat card's revert and the check before it.
    expect(cardRevertMessage(503, code)).toBe(sentence);
    expect(revertCheckFailedCopy(code)).toBe(sentence);
    // Never the unreachable sentence.
    expect(sentence).not.toBe(STATELESS_UNREACHABLE_COPY);
  });

  it("keeps the edits in the save's sentence and says when to try again", () => {
    const save = (code: string) =>
      describeSaveFailure({ error: originError({ code, status: 503 }), mode: "stateless", label: "a.md" });
    expect(save("writes_busy")).toEqual({
      message: "The server is busy saving other changes. Your edits are kept here. Try again in a moment.",
      action: { kind: "retry", label: "Try again" },
    });
    expect(save("mirror_reset")).toEqual({
      message: "The server is rebuilding its copy of this space. Your edits are kept here. Try again in a moment.",
      action: { kind: "retry", label: "Try again" },
    });
    // Out of room: later, not in a moment, so no Try again.
    expect(save("disk_full")).toEqual({
      message: "The space is out of room right now. Your edits are kept here. Try again later.",
    });
    expect(SAVE_COPY.writesBusy).toBe(save("writes_busy").message);
    expect(SAVE_COPY.mirrorReset).toBe(save("mirror_reset").message);
    expect(SAVE_COPY.diskFull).toBe(save("disk_full").message);
    // A Desktop space never gets these answers, but the words would be the same.
    expect(
      describeSaveFailure({ error: originError({ code: "disk_full", status: 503 }), mode: "desktop", label: "a.md" })
        .message,
    ).toBe(SAVE_COPY.diskFull);
    expect(
      describeSaveFailure({
        error: originError({ code: "writes_busy", status: 503 }),
        mode: "stateless",
        label: "docs",
        operation: "create",
      }),
    ).toEqual({ message: WRITES_BUSY_COPY, action: { kind: "retry", label: "Try again" } });
    expect(retryLaterCopy("main_busy")).toBeNull();
    expect(retryLaterCopy(undefined)).toBeNull();
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

  it("names old chat uploads in a sentence of their own on Restore", () => {
    const placement = { unsavedWorkInHistory: true };
    const attachmentRule = describeFileNotSaved({ reason: "attachment", keptSavedVersion: false }, placement);
    expect(attachmentRule).toBe("Old chat upload files aren't saved to the space.");
    // Only old chat uploads were left out: the secret and ignored sentence would be wrong.
    expect(
      restoreSuccessCopy({
        committed: true,
        notRestored: ["chat-upload-1.png"],
        reasons: { "chat-upload-1.png": "attachment" },
      }),
    ).toBe(`Restored as a new version. Not restored: chat-upload-1.png. ${attachmentRule}`);
    // Both kinds: one list, then one sentence for each.
    expect(
      restoreSuccessCopy({
        committed: true,
        notRestored: [".env", "chat-upload-1.png"],
        reasons: { ".env": "secret", "chat-upload-1.png": "attachment" },
      }),
    ).toBe(
      `Restored as a new version. Not restored: .env and chat-upload-1.png. Secret and ignored files stay out of the space. ${attachmentRule}`,
    );
    // Desktop lists paths without reasons: the one sentence as before.
    expect(restoreSuccessCopy({ committed: true, notRestored: [".env", "chat-upload-1.png"] })).toBe(
      "Restored as a new version. Not restored: .env and chat-upload-1.png. Secret and ignored files stay out of the space.",
    );
  });

  it("never names a path the restore kept on request as refused", () => {
    // Keep on a folder covers the files below it; the gateway names each one `kept`.
    expect(
      restoreSuccessCopy({
        committed: true,
        notRestored: ["src/lib/a.ts"],
        kept: ["src/lib"],
        reasons: { "src/lib/a.ts": "kept" },
      }),
    ).toBe("Restored as a new version. Kept the current version of src/lib.");
  });

  it("says a kept name the space holds in another case stays in Unsaved work", () => {
    // `Docs/guide.md` is below the kept folder `Docs`; both are on the ref only.
    expect(
      restoreSuccessCopy({
        committed: true,
        notRestored: ["Docs/guide.md", "notes.md", "todo.md"],
        kept: ["Docs", "notes.md", "todo.md"],
        reasons: { "Docs/guide.md": "path_alias", "notes.md": "kept", "todo.md": "path_alias" },
      }),
    ).toBe(
      "Restored as a new version. Kept the current version of Docs and notes.md. Docs/guide.md and todo.md stay in Unsaved work, because the space has other files with those names in a different case.",
    );
  });

  it("says there was nothing to restore when main already had the work", () => {
    expect(NOTHING_TO_RESTORE_COPY).toBe("Nothing to restore. The saved version already has this work.");
    expect(restoreSuccessCopy({ committed: false, notRestored: [] })).toBe(NOTHING_TO_RESTORE_COPY);
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
