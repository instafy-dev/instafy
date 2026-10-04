import { describe, expect, it } from "vitest";

import type { RevertWorkspaceGitCommitResult } from "../../../../services/runtimeController/workspaceGit";
import { describeChangeRevertOutcome, describeUnsavedChanges } from "../chatFileChangeCopy";

function failure(
  status: number,
  code?: string,
  extra: Partial<RevertWorkspaceGitCommitResult> = {},
): RevertWorkspaceGitCommitResult {
  return {
    ok: false,
    conflict: status === 409,
    code,
    errorInfo: { status, code, message: "origin said no", routeUnavailable: false },
    ...extra,
  };
}

describe("describeChangeRevertOutcome", () => {
  it("reports a saved revert, and nothing to do when the change is already undone", () => {
    expect(describeChangeRevertOutcome({ ok: true, rev: "c".repeat(40), committed: true })).toEqual({
      intent: "success",
      message: "Reverted. Saved as a new version.",
      reverted: true,
      unrevertedPaths: [],
      offerAgentUndo: false,
    });
    // Older origins do not say whether they committed: a 200 is a revert.
    expect(describeChangeRevertOutcome({ ok: true, rev: "c".repeat(40) }).reverted).toBe(true);
    expect(describeChangeRevertOutcome({ ok: true, rev: "c".repeat(40), committed: false })).toMatchObject({
      intent: "info",
      message: "Nothing to revert. Those changes are already undone.",
      reverted: false,
    });
  });

  it("names the files a Desktop origin's partial publish left out", () => {
    const outcome = describeChangeRevertOutcome({
      ok: true,
      rev: "c".repeat(40),
      report: {
        rev: "c".repeat(40),
        baseRev: null,
        localRev: null,
        gitSyncStatus: "partial",
        recoveryRef: null,
        recoveryRefs: [],
        conflictedPaths: ["a.md", "b.md"],
        rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
        checkoutMoved: false,
        unpushedRefs: 0,
        failure: null,
        retryable: false,
      },
    });
    expect(outcome).toMatchObject({
      intent: "warning",
      message: "Reverted and saved as a new version. Not saved: a.md, b.md and .env.",
      reverted: true,
      unrevertedPaths: ["a.md", "b.md", ".env"],
    });
  });

  it("offers the agent when later changes conflict", () => {
    expect(describeChangeRevertOutcome(failure(409, "revert_conflict", { paths: ["a.md"] }))).toMatchObject({
      intent: "warning",
      message: "Later changes touch the same lines, so this can't be reverted automatically.",
      reverted: false,
      offerAgentUndo: true,
    });
  });

  it("says when the server has no revert route yet", () => {
    expect(
      describeChangeRevertOutcome({
        ok: false,
        conflict: false,
        routeUnavailable: true,
        errorInfo: { status: 404, message: "origin path not found", routeUnavailable: true },
      }),
    ).toMatchObject({
      message: "Reverting isn't available on this server yet. Ask the agent to undo it instead.",
      offerAgentUndo: true,
    });
  });

  it("maps busy, lease and dirty-folder refusals without leaking server text", () => {
    expect(describeChangeRevertOutcome(failure(409, "main_busy")).message).toBe(
      "The space is busy saving other changes. Try again in a moment.",
    );
    expect(describeChangeRevertOutcome(failure(409)).message).toBe(
      "The space is busy saving other changes. Try again in a moment.",
    );
    const lease = describeChangeRevertOutcome(failure(409, "lease_conflict"));
    expect(lease.message).toBe("The agent is saving right now. Try again in a moment.");
    expect(lease.message).not.toMatch(/leased by|[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(
      describeChangeRevertOutcome(failure(409, "dirty_paths", { paths: ["a.md", "b.md", "c.md", "d.md"] })).message,
    ).toBe("Files on this computer have edits this revert would change: a.md, b.md, c.md and 1 more. Save them first.");
    expect(describeChangeRevertOutcome(failure(409, "dirty_paths", { paths: ["a.md"] })).message).toBe(
      "Files on this computer have edits this revert would change: a.md. Save them first.",
    );
  });

  it("maps unreachable origins, missing commits and refused requests", () => {
    for (const [status, code] of [
      [502, "canonical_unreachable"],
      [503, "fetch_pending"],
      [0, "token_unavailable"],
      [0, "network_error"],
      [503, undefined],
    ] as const) {
      expect(describeChangeRevertOutcome(failure(status, code)).message).toBe(
        "Couldn't reach the space's saved files. Try again.",
      );
    }
    expect(describeChangeRevertOutcome(failure(404, "not_found"))).toMatchObject({
      message: "This change isn't in the space's saved history, so it can't be reverted here. Ask the agent to undo it.",
      offerAgentUndo: true,
    });
    expect(describeChangeRevertOutcome(failure(400))).toMatchObject({
      message: "This change can't be reverted here. Ask the agent to undo it.",
      offerAgentUndo: true,
    });
    expect(describeChangeRevertOutcome(failure(409, "not_saved")).message).toBe(
      "The revert wasn't saved to the space. Try again in a moment.",
    );
    expect(describeChangeRevertOutcome(failure(500))).toMatchObject({
      intent: "error",
      message: "Couldn't revert this change. Try again, or ask the agent to undo it.",
      offerAgentUndo: true,
    });
    expect(describeChangeRevertOutcome(null).message).toBe(
      "Couldn't revert this change. Try again, or ask the agent to undo it.",
    );
  });
});

describe("describeUnsavedChanges", () => {
  it("promises the next turn's save only for a save that failed", () => {
    expect(describeUnsavedChanges("save_failed", { unsavedWorkInHistory: false, saveVersionInChanges: true })).toBe(
      "These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is kept as unsaved work.",
    );
    expect(describeUnsavedChanges("save_failed", { unsavedWorkInHistory: true })).toBe(
      "These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is kept under History, in Unsaved work.",
    );
  });

  it("says saving is off without promising a later save", () => {
    // RUNTIME_GIT_SYNC_AFTER_APPLY=0 turns saving off for every turn on that
    // runtime: no later turn saves, and nothing is kept as unsaved work.
    const legacy = describeUnsavedChanges("auto_save_off", { unsavedWorkInHistory: false, saveVersionInChanges: true });
    expect(legacy).toBe(
      "Saving is turned off on this space's runtime, so these changes weren't saved to the space. To save them, open Changes and use Save version.",
    );
    const stateless = describeUnsavedChanges("auto_save_off", { unsavedWorkInHistory: true });
    expect(stateless).toBe("Saving is turned off on this space's runtime, so these changes weren't saved to the space.");
    for (const text of [legacy, stateless]) {
      expect(text).not.toMatch(/next turn|unsaved work/i);
    }
  });
});
