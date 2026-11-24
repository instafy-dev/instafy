// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRecovery: vi.fn(),
  versioning: {
    projectId: "project-1" as string | null,
    originId: "origin-1" as string | null,
    historyReady: true,
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { fetchRecovery: mocks.fetchRecovery } } },
}));
vi.mock("../../../../workspace/useActiveWorkspaceVersioning", () => ({
  useActiveWorkspaceVersioning: () => mocks.versioning,
}));

import { markUnsavedWorkSeen, resetUnsavedWorkSeenForTests } from "../../../../workspace/unsavedWorkSeen";
import {
  getUnsavedWorkSnapshot,
  resetUnsavedWorkStoreForTests,
  setUnsavedWorkLiveOrigins,
} from "../../../../workspace/unsavedWorkStore";
import { useUnsavedWorkNotice, type UnsavedWorkNotice } from "../useUnsavedWorkNotice";

type Message = { metadata?: Record<string, unknown> | null };

function recovery(ref: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    rev: "a".repeat(40),
    kind: "unpublished",
    subject: "",
    date: null,
    origin: null,
    paths: ["a.txt"],
    base: null,
    ...extra,
  };
}

function ok(entries: unknown[]) {
  return { status: "ok", entries, originId: "origin-1", originMode: "hosted" };
}

function applyMessage(ref: string): Message {
  return { metadata: { artifacts: [{ kind: "origin/apply", metadata: { recoveryRef: ref } }] } };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("useUnsavedWorkNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let notice: UnsavedWorkNotice | null = null;

  function Probe({ userId, messages }: { userId: string | null; messages: Message[] }) {
    notice = useUnsavedWorkNotice({ userId, messages });
    return null;
  }

  async function render(userId: string | null = "user-1", messages: Message[] = []) {
    await act(async () => root.render(<Probe userId={userId} messages={messages} />));
    await flush();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetUnsavedWorkStoreForTests();
    resetUnsavedWorkSeenForTests();
    window.localStorage.clear();
    mocks.versioning = { projectId: "project-1", originId: "origin-1", historyReady: true };
    mocks.fetchRecovery.mockReset();
    mocks.fetchRecovery.mockResolvedValue(
      ok([
        recovery("refs/instafy/recovery/o/a"),
        recovery("refs/instafy/recovery/o/b"),
        recovery("refs/instafy/recovery/o/c", { restoredRev: "f".repeat(40) }),
      ]),
    );
    notice = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stays silent in legacy spaces and lists nothing", async () => {
    mocks.versioning = { projectId: "project-1", originId: "origin-1", historyReady: false };
    await render();
    expect(notice).toBeNull();
    expect(mocks.fetchRecovery).not.toHaveBeenCalled();
  });

  it("appears once per new entry and per viewer, and Dismiss remembers it", async () => {
    await render();
    expect(notice?.count).toBe(2);
    await act(async () => notice?.onDismiss());
    expect(notice).toBeNull();
    expect(window.localStorage.getItem("instafy.unsavedWork.seen.project-1.user-1")).toContain(
      "refs/instafy/recovery/o/a@",
    );

    // Back again later: still seen.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(notice).toBeNull();

    // Another viewer on this browser has not seen it.
    await render("user-2");
    expect(notice?.count).toBe(2);
  });

  it("still hides for this session when the browser refuses to store what was seen", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    try {
      await render();
      expect(notice?.count).toBe(2);
      await act(async () => notice?.onDismiss());
      expect(notice).toBeNull();
      expect(window.localStorage.getItem("instafy.unsavedWork.seen.project-1.user-1")).toBeNull();

      // Open History retires the row the same way.
      await render("user-2");
      expect(notice?.count).toBe(2);
      await act(async () => notice?.onOpenHistory());
      expect(notice).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("Open History marks the entries seen and opens the drawer", async () => {
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("instafy:open-source-control", listener);
    await render();
    await act(async () => notice?.onOpenHistory());
    window.removeEventListener("instafy:open-source-control", listener);
    expect(opened).toEqual([{ projectId: "project-1" }]);
    expect(notice).toBeNull();
  });

  it("goes away when History shows the entries to this viewer", async () => {
    await render();
    expect(notice?.count).toBe(2);
    await act(async () => {
      markUnsavedWorkSeen("project-1", "user-1", [
        `refs/instafy/recovery/o/a@${"a".repeat(40)}`,
        `refs/instafy/recovery/o/b@${"a".repeat(40)}`,
      ]);
    });
    expect(notice).toBeNull();
  });

  it("never raises the row for a running workspace's rolling save", async () => {
    const running = "11111111-1111-4111-8111-111111111111";
    const stopped = "22222222-2222-4222-8222-222222222222";
    mocks.fetchRecovery.mockResolvedValue(
      ok([
        recovery("refs/instafy/recovery/o/a", { origin: running }),
        recovery("refs/instafy/recovery/w1/working", { kind: "unsaved", origin: running, rollingSave: true }),
        recovery("refs/instafy/recovery/w2/working", { kind: "unsaved", origin: stopped, rollingSave: true }),
      ]),
    );
    setUnsavedWorkLiveOrigins("project-1", [running]);
    await render();
    expect(notice?.count).toBe(2);
    await act(async () => notice?.onDismiss());
    const seen = window.localStorage.getItem("instafy.unsavedWork.seen.project-1.user-1") ?? "";
    expect(seen).toContain("refs/instafy/recovery/w2/working@");
    expect(seen).not.toContain("refs/instafy/recovery/w1/working@");
  });

  // A local test, Nov 22: a change stopped before its save was put back by
  // the chat's next turn, its row read "Undone" and History kept it under
  // Unsaved work, and then a "Some work wasn't saved" card showed in every
  // chat of the space.
  describe("work kept when a change was taken back", () => {
    const FILE = "sites/visit/index.html";
    const KEPT = "refs/instafy/recovery/o/20261122T232737Z-undone-1";
    const undoLine = (paths: string[], by: Record<string, unknown>): Message => ({
      metadata: {
        source: "controller", kind: "change_undone", presentation: { hidden: true },
        undoneMessageId: "stopped-row", undoneRunId: "stopped-run", undonePaths: paths, ...by,
      },
    });
    const putBackByNextTurn = undoLine([FILE], { putBackByJobId: "next-turn-job" });
    const undoneByPerson = undoLine([`./${FILE}`], { actorUserId: "user-1" });

    beforeEach(() => {
      mocks.fetchRecovery.mockResolvedValue(ok([recovery(KEPT, { kind: "undone", paths: [FILE] })]));
    });

    it("tells no chat of what Octo's next turn put back, and History keeps it", async () => {
      // The chat it happened in, then another chat of the space.
      await render("user-1", [putBackByNextTurn]);
      expect(notice).toBeNull();
      await render("user-1", []);
      expect(notice).toBeNull();
      expect(getUnsavedWorkSnapshot("project-1", "origin-1").entries.map((entry) => entry.ref)).toEqual([KEPT]);
      expect(window.localStorage.getItem("instafy.unsavedWork.seen.project-1.user-1")).toBeNull();
    });

    it("tells of a person's own Undo only in the chat it was made in", async () => {
      await render("user-1", [undoneByPerson]);
      expect(notice?.count).toBe(1);
      await render("user-1", []);
      expect(notice).toBeNull();
      // A line in another chat that names other files is not that Undo.
      await render("user-1", [undoLine(["sites/other/index.html"], { actorUserId: "user-1" })]);
      expect(notice).toBeNull();
      // Back in its own chat, Dismiss retires it.
      await render("user-1", [undoneByPerson]);
      expect(notice?.count).toBe(1);
      await act(async () => notice?.onDismiss());
      expect(notice).toBeNull();
    });

    it("tells of other work kept as before, beside a change taken back", async () => {
      mocks.fetchRecovery.mockResolvedValue(ok([
        recovery(KEPT, { kind: "undone", paths: [FILE] }),
        recovery("refs/instafy/recovery/o/20261122T232800Z-conflict-2", { kind: "conflict", paths: ["sites/visit/app.js"] }),
      ]));
      await render("user-1", [putBackByNextTurn]);
      expect(notice?.count).toBe(1);
      await render("user-1", []);
      expect(notice?.count).toBe(1);
      await act(async () => notice?.onDismiss());
      const seen = window.localStorage.getItem("instafy.unsavedWork.seen.project-1.user-1") ?? "";
      expect(seen).toContain("-conflict-2@");
      expect(seen).not.toContain("-undone-1@");
    });
  });

  it("lists again when a finished turn reports a new recovery ref", async () => {
    await render("user-1", [applyMessage("refs/instafy/recovery/o/a")]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    await render("user-1", [applyMessage("refs/instafy/recovery/o/a")]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    mocks.fetchRecovery.mockResolvedValue(
      ok([recovery("refs/instafy/recovery/o/a"), recovery("refs/instafy/recovery/o/b"), recovery("refs/instafy/recovery/o/new")]),
    );
    await render("user-1", [applyMessage("refs/instafy/recovery/o/a"), applyMessage("refs/instafy/recovery/o/new")]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(notice?.count).toBe(3);
  });
});
