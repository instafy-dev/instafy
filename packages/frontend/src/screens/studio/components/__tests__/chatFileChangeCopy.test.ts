import { describe, expect, it } from "vitest";

import type { RevertWorkspaceGitCommitResult } from "../../../../services/runtimeController/workspaceGit";
import {
  describeChangeRevertOutcome,
  describeRevertConfirm,
  describeRevertOtherWork,
  describeUnsavedChanges,
  revertRetryDelayMs,
} from "../chatFileChangeCopy";

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

describe("a revert while the space is still loading", () => {
  function pending(retryAfterMs?: number): RevertWorkspaceGitCommitResult {
    return {
      ok: false,
      conflict: false,
      code: "fetch_pending",
      errorInfo: { status: 503, code: "fetch_pending", message: "fetch pending", retryAfterMs, routeUnavailable: false },
    };
  }

  it("retries once after Retry-After, capped at 5 s", () => {
    expect(revertRetryDelayMs(pending(2000))).toBe(2000);
    expect(revertRetryDelayMs(pending(0))).toBe(0);
    expect(revertRetryDelayMs(pending(9000))).toBe(5000);
    expect(revertRetryDelayMs(pending())).toBe(2000);
  });

  it("does not retry anything else", () => {
    expect(revertRetryDelayMs(null)).toBeNull();
    expect(revertRetryDelayMs({ ok: true, rev: "c".repeat(40) })).toBeNull();
    expect(revertRetryDelayMs(failure(503))).toBeNull();
    expect(revertRetryDelayMs(failure(502, "canonical_unreachable"))).toBeNull();
    expect(revertRetryDelayMs(failure(409, "main_busy"))).toBeNull();
  });

  it("says the space is still loading, not that it is unreachable", () => {
    expect(describeChangeRevertOutcome(pending(2000))).toMatchObject({
      intent: "warning",
      message: "The space is still loading. Try again in a moment.",
      reverted: false,
    });
  });
});

describe("describeChangeRevertOutcome for refused paths", () => {
  // The path policy refuses a revert that would bring back a file the space
  // never saves. The answer is the same on every attempt.
  function refused(code: string, reason?: string, paths?: string[]): RevertWorkspaceGitCommitResult {
    return {
      ok: false,
      conflict: false,
      code,
      errorInfo: { status: 422, code, reason, paths, message: "refused", routeUnavailable: false },
    };
  }

  it("names the file rule, never says to try again, and offers the agent", () => {
    const cases = [
      [refused("excluded_path", "secret"), "This change can't be reverted here. Secret files stay out of the space. Ask the agent to undo it."],
      [
        refused("excluded_path", "secret", [".env"]),
        "This change can't be reverted here because it would bring back .env. Secret files stay out of the space. Ask the agent to undo it.",
      ],
      [
        refused("excluded_path"),
        "This change can't be reverted here. Build output, dependency and cache folders aren't saved to the space. Ask the agent to undo it.",
      ],
      [
        refused("excluded_path", "attachment"),
        "This change can't be reverted here. Old chat upload files aren't saved to the space. Ask the agent to undo it.",
      ],
      [
        refused("ignored_path"),
        "This change can't be reverted here. Files that match .gitignore aren't saved to the space. Ask the agent to undo it.",
      ],
      [
        refused("policy_rejected", "too_large"),
        "This change can't be reverted here. Files larger than 20 MB aren't saved to the space. Ask the agent to undo it.",
      ],
      [
        refused("policy_rejected"),
        "This change can't be reverted here. This space's file rules refused one of its files. Ask the agent to undo it.",
      ],
      [refused("something_new"), "This change can't be reverted here. Ask the agent to undo it."],
    ] as const;
    for (const [result, message] of cases) {
      const outcome = describeChangeRevertOutcome(result);
      expect(outcome).toMatchObject({ intent: "warning", message, reverted: false, offerAgentUndo: true });
      expect(outcome.message).not.toMatch(/try again/i);
    }
  });

  it("keeps the Desktop origin's passing 422 retryable", () => {
    expect(describeChangeRevertOutcome(refused("dismissal_not_applied"))).toMatchObject({
      intent: "warning",
      message:
        "The revert isn't saved yet: work you removed is still on this computer's branch. Try again in a moment.",
      offerAgentUndo: false,
    });
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

describe("describeRevertConfirm", () => {
  it("names the files the turn saved without listing them", () => {
    expect(describeRevertConfirm([])).toBe(
      "A new version that undoes it is saved on top. Nothing is removed from history.",
    );
    expect(describeRevertConfirm(["package-lock.json", "dist/app.js"])).toBe(
      "A new version that undoes it is saved on top. Nothing is removed from history. It also undoes this turn's changes to package-lock.json and dist/app.js.",
    );
  });
});

describe("describeRevertOtherWork", () => {
  it("names the other files a version would undo, and the way forward", () => {
    expect(describeRevertOtherWork(["notes/a.md"], true)).toBe(
      "This change was saved together with other work, so reverting it here would also undo notes/a.md. Ask the agent to undo just this change.",
    );
    expect(describeRevertOtherWork(["a.md", "b.md", "c.md", "d.md", "e.md"], false)).toBe(
      "This change was saved together with other work, so reverting it here would also undo a.md, b.md, c.md and 2 more.",
    );
  });
});
