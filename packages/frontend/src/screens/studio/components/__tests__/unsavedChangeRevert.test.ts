import { describe, expect, it } from "vitest";

import type { ControllerRuntimeStatusEntry } from "../../../../sdk/instafy";
import { undoFolderRuntimeId } from "../unsavedChangeRevert";

const machine = (
  runtimeId: string,
  originId: string | null,
  {
    ready = true,
    released = false,
    silent = false,
  }: { ready?: boolean; released?: boolean; silent?: boolean } = {},
): ControllerRuntimeStatusEntry => ({
  runtimeId,
  status: ready ? "ready" : "stopped",
  provider: "instafy-cloud",
  idleTtlSeconds: 600,
  isLocal: false,
  isPreferred: false,
  // A machine that stopped answering stays "ready", with its folder's origin, until it is swept.
  health: ready && !silent ? "online" : "offline",
  origin: originId ? { originId, status: released ? "released" : "online", protocols: ["http"] } : null,
});

describe("undoFolderRuntimeId", () => {
  it("takes the machine that ran the change's turn while it serves its folder", () => {
    const statuses = [machine("turn", "turn-origin"), machine("now", "now-origin")];
    expect(undoFolderRuntimeId(statuses, { runtimeId: "turn" }, "now")).toBe("turn");
    // Named by the origin its save went through.
    expect(undoFolderRuntimeId(statuses, { originId: "turn-origin" }, "now")).toBe("turn");
    // A change no save took is only in the folder of the machine that ran its turn, answering or not.
    const silent = [machine("turn", "turn-origin", { silent: true }), machine("now", "now-origin")];
    expect(undoFolderRuntimeId(silent, { runtimeId: "turn" }, "now")).toBe("turn");
  });

  // Any folder that answers can follow a saved version: the one it was saved
  // from only while that machine still answers.
  it("passes over the machine a saved change came from once it no longer answers", () => {
    const statuses = [machine("old", "old-origin", { silent: true }), machine("new", "new-origin")];
    expect(undoFolderRuntimeId(statuses, { originId: "old-origin" }, null)).toBe("new");
    expect(undoFolderRuntimeId(statuses, { originId: "old-origin" }, "new")).toBe("new");
    expect(
      undoFolderRuntimeId([...statuses, machine("third", "third-origin")], { originId: "old-origin" }, "third"),
    ).toBe("third");
  });

  // A local test, Nov 5: a map's Undo in a space whose machine nobody had
  // chosen. The space had no current machine, so its folder never followed.
  it("takes the space's one ready machine with a folder when the space has no current machine", () => {
    const statuses = [machine("only", "only-origin"), machine("stopped", null, { ready: false })];
    expect(undoFolderRuntimeId(statuses, {}, null)).toBe("only");
    expect(undoFolderRuntimeId(statuses, { originId: "an-origin-no-machine-serves" }, null)).toBe("only");
    // The turn's machine stopped since: its folder is gone with it.
    expect(undoFolderRuntimeId([...statuses, machine("turn", "turn-origin", { released: true })], { runtimeId: "turn" }, null)).toBe("only");
  });

  it("takes the space's current machine only when nothing else says which", () => {
    const statuses = [machine("one", "one-origin"), machine("two", "two-origin")];
    expect(undoFolderRuntimeId(statuses, {}, "two")).toBe("two");
    expect(undoFolderRuntimeId(statuses, {}, null)).toBeNull();
    expect(undoFolderRuntimeId([], { runtimeId: "turn", originId: "turn-origin" }, null)).toBeNull();
  });
});
