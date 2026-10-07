// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchRecovery: vi.fn() }));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { fetchRecovery: mocks.fetchRecovery } } },
}));

import type { ControllerRuntimeStatusEntry, WorkspaceRecoveryEntry } from "../../sdk/instafy";
import {
  getRollingSaveScope,
  getUnsavedWorkConflicts,
  getUnsavedWorkSnapshot,
  liveOriginIds,
  patchUnsavedWorkEntries,
  pendingUnsavedWorkEntries,
  refreshUnsavedWork,
  resetUnsavedWorkStoreForTests,
  setUnsavedWorkLiveOrigins,
  UNSAVED_WORK_FOCUS_REFRESH_MS,
  UNSAVED_WORK_STOP_REFETCH_DELAY_MS,
  updateUnsavedWorkConflicts,
  usePublishUnsavedWorkLiveOrigins,
  useUnsavedWork,
  visibleUnsavedWorkEntries,
  type UseUnsavedWorkResult,
} from "../unsavedWorkStore";

function entry(ref: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    rev: `${ref.length}`.padStart(40, "a"),
    kind: "unpublished",
    subject: "Agent work",
    date: "2026-10-01T10:00:00Z",
    origin: null,
    paths: ["a.txt"],
    base: null,
    ...extra,
  };
}

function ok(entries: unknown[]) {
  return { status: "ok", entries, originId: "o", originMode: "hosted" };
}

const LIVE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A working folder's rolling save, last written by `origin`. */
function rollingSave(folder: string, origin: string | null, revision = "1"): WorkspaceRecoveryEntry {
  return entry(`refs/instafy/recovery/${folder}/working`, {
    kind: "unsaved",
    origin,
    rollingSave: true,
    rev: revision.padStart(40, "c"),
  }) as WorkspaceRecoveryEntry;
}

function runtimeStatus(originId: string | null, originStatus = "online"): ControllerRuntimeStatusEntry {
  return {
    runtimeId: `runtime-${originId ?? "none"}`,
    status: "running",
    provider: "docker",
    idleTtlSeconds: 600,
    isLocal: false,
    isPreferred: false,
    health: "online",
    origin: originId === null ? null : { originId, status: originStatus, protocols: ["http"] },
  };
}

function refsOf(entries: WorkspaceRecoveryEntry[]): string[] {
  return entries.map((item) => item.ref);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("unsaved work store", () => {
  beforeEach(() => {
    resetUnsavedWorkStoreForTests();
    mocks.fetchRecovery.mockReset();
  });

  it("joins a list already on the wire and stores the answer", async () => {
    const wire = deferred<unknown>();
    mocks.fetchRecovery.mockReturnValue(wire.promise);
    const first = refreshUnsavedWork({ projectId: "p", originId: "o" });
    const second = refreshUnsavedWork({ projectId: "p", originId: "o" });
    expect(getUnsavedWorkSnapshot("p", "o").loading).toBe(true);
    wire.resolve(ok([entry("refs/instafy/recovery/x/a")]));
    await Promise.all([first, second]);
    expect(mocks.fetchRecovery).toHaveBeenCalledOnce();
    expect(mocks.fetchRecovery).toHaveBeenCalledWith({ projectId: "p", originId: "o" });
    const snapshot = getUnsavedWorkSnapshot("p", "o");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.loading).toBe(false);
  });

  it("reuses a fresh list within maxAge and fetches again when forced", async () => {
    mocks.fetchRecovery.mockResolvedValue(ok([]));
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    await refreshUnsavedWork({ projectId: "p", originId: "o", maxAgeMs: 60_000 });
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);
    await refreshUnsavedWork({ projectId: "p", originId: "o", maxAgeMs: 60_000, force: true });
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
  });

  it("marks a missing route unsupported and keeps the last list through an error", async () => {
    mocks.fetchRecovery.mockResolvedValueOnce({ status: "unsupported", entries: [], originId: "o", originMode: "desktop" });
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    expect(getUnsavedWorkSnapshot("p", "o").status).toBe("unsupported");

    mocks.fetchRecovery.mockResolvedValueOnce(ok([entry("refs/instafy/recovery/x/a")]));
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    mocks.fetchRecovery.mockResolvedValueOnce({
      status: "error",
      entries: [],
      error: { status: 502, code: "canonical_unreachable", message: "down", routeUnavailable: false },
      originId: "o",
      originMode: "hosted",
    });
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    const snapshot = getUnsavedWorkSnapshot("p", "o");
    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.status).toBe(502);
    expect(snapshot.entries).toHaveLength(1);
  });

  it("lets only the newest fetch store its answer", async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    mocks.fetchRecovery.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = refreshUnsavedWork({ projectId: "p", originId: "o" });
    const second = refreshUnsavedWork({ projectId: "p", originId: "o", force: true });
    newer.resolve(ok([]));
    await second;
    older.resolve(ok([entry("refs/instafy/recovery/x/stale")]));
    await first;
    expect(getUnsavedWorkSnapshot("p", "o").entries).toEqual([]);
  });

  it("patches entries locally and counts only pending work", async () => {
    mocks.fetchRecovery.mockResolvedValue(
      ok([entry("refs/instafy/recovery/x/a"), entry("refs/instafy/recovery/x/b", { restoredRev: "f".repeat(40) })]),
    );
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    expect(pendingUnsavedWorkEntries(getUnsavedWorkSnapshot("p", "o").entries)).toHaveLength(1);
    patchUnsavedWorkEntries("p", "o", (entries) => entries.filter((item) => item.ref !== "refs/instafy/recovery/x/a"));
    expect(getUnsavedWorkSnapshot("p", "o").entries.map((item) => item.ref)).toEqual(["refs/instafy/recovery/x/b"]);
  });

  it("keeps restore choices while the entry still names the same work", async () => {
    const kept = entry("refs/instafy/recovery/o/kept");
    const moved = entry("refs/instafy/recovery/o/moved-ref");
    const gone = entry("refs/instafy/recovery/o/gone-ref-x");
    mocks.fetchRecovery.mockResolvedValueOnce(ok([kept, moved, gone]));
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    for (const item of [kept, moved, gone]) {
      updateUnsavedWorkConflicts("p", "o", (current) => ({
        ...current,
        [item.ref]: { rev: item.rev, head: null, paths: ["a.txt"], resolutions: { "a.txt": "keep" } },
      }));
    }
    expect(Object.keys(getUnsavedWorkConflicts("p", "o"))).toHaveLength(3);
    // Another project or origin has none.
    expect(getUnsavedWorkConflicts("p", "other")).toEqual({});

    mocks.fetchRecovery.mockResolvedValueOnce(ok([kept, { ...moved, rev: "f".repeat(40) }]));
    await refreshUnsavedWork({ projectId: "p", originId: "o", force: true });
    expect(Object.keys(getUnsavedWorkConflicts("p", "o"))).toEqual([kept.ref]);

    mocks.fetchRecovery.mockResolvedValueOnce({ status: "unsupported", entries: [], originId: "o", originMode: "desktop" });
    await refreshUnsavedWork({ projectId: "p", originId: "o", force: true });
    expect(getUnsavedWorkConflicts("p", "o")).toEqual({});
  });
});

describe("rolling saves", () => {
  beforeEach(() => {
    resetUnsavedWorkStoreForTests();
    mocks.fetchRecovery.mockReset();
  });

  afterEach(() => {
    resetUnsavedWorkStoreForTests();
    vi.useRealTimers();
  });

  /** Let the fetch after a stop and its follow-up settle (no React here). */
  async function microtasks() {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  }

  function visible(projectId = "p", originId = "o"): WorkspaceRecoveryEntry[] {
    return visibleUnsavedWorkEntries(getUnsavedWorkSnapshot(projectId, originId).entries, getRollingSaveScope(projectId));
  }

  it("returns a list without the flag as it is, whatever is live", () => {
    const entries = [entry("refs/instafy/recovery/x/a", { origin: LIVE })] as WorkspaceRecoveryEntry[];
    expect(visibleUnsavedWorkEntries(entries, { known: false, hidden: new Set() })).toBe(entries);
    expect(visibleUnsavedWorkEntries(entries, { known: true, hidden: new Set([LIVE]) })).toBe(entries);
  });

  it("hides only a rolling save whose last writer is live, or every one while that is unknown", () => {
    const conflict = entry(`refs/instafy/recovery/${LIVE}/run-1`, { kind: "conflict", origin: LIVE });
    const unpublished = entry(`refs/instafy/recovery/${LIVE}/run-2`, { origin: LIVE });
    const live = rollingSave("folder-1", LIVE);
    const stopped = rollingSave("folder-2", OTHER);
    const unnamed = rollingSave("folder-3", null);
    const entries = [conflict, unpublished, live, stopped, unnamed] as WorkspaceRecoveryEntry[];

    expect(refsOf(visibleUnsavedWorkEntries(entries, { known: false, hidden: new Set() }))).toEqual([
      conflict.ref,
      unpublished.ref,
    ]);
    expect(refsOf(visibleUnsavedWorkEntries(entries, { known: true, hidden: new Set([LIVE]) }))).toEqual([
      conflict.ref,
      unpublished.ref,
      stopped.ref,
      unnamed.ref,
    ]);
  });

  it("reads the live origins from the runtime status", () => {
    expect(
      liveOriginIds([
        runtimeStatus(` ${LIVE} `),
        runtimeStatus(OTHER, "released"),
        runtimeStatus(null),
        runtimeStatus(""),
      ]),
    ).toEqual([LIVE]);
  });

  it("keeps the last live set through an unknown moment and starts over for another project", () => {
    expect(getRollingSaveScope("p").known).toBe(false);
    setUnsavedWorkLiveOrigins("p", null);
    expect(getRollingSaveScope("p").known).toBe(false);

    setUnsavedWorkLiveOrigins("p", [LIVE]);
    expect(getRollingSaveScope("p").known).toBe(true);
    expect(getRollingSaveScope("p").hidden.has(LIVE)).toBe(true);

    setUnsavedWorkLiveOrigins("p", null);
    expect(getRollingSaveScope("p").hidden.has(LIVE)).toBe(true);
    expect(getRollingSaveScope("q").known).toBe(false);

    setUnsavedWorkLiveOrigins("q", [OTHER]);
    expect(getRollingSaveScope("q").hidden.has(OTHER)).toBe(true);
    expect(getRollingSaveScope("p").known).toBe(false);
  });

  it("lists again once after stops and shows the final save, with its final rev, only then", async () => {
    vi.useFakeTimers();
    mocks.fetchRecovery.mockResolvedValueOnce(ok([rollingSave("folder-1", LIVE, "1")]));
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    setUnsavedWorkLiveOrigins("p", [LIVE, OTHER]);
    expect(visible()).toEqual([]);

    mocks.fetchRecovery.mockResolvedValueOnce(ok([rollingSave("folder-1", LIVE, "2")]));
    setUnsavedWorkLiveOrigins("p", [OTHER]);
    // A second stop close behind shares the same list.
    await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS / 2);
    setUnsavedWorkLiveOrigins("p", []);
    // Stopped, but the list in hand is older than the final save: still hidden.
    expect(visible()).toEqual([]);
    await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS - 1);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await microtasks();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.fetchRecovery).toHaveBeenLastCalledWith({ projectId: "p", originId: "o" });
    expect(visible().map((item) => item.rev)).toEqual([rollingSave("folder-1", LIVE, "2").rev]);
    expect(getRollingSaveScope("p").hidden.size).toBe(0);

    await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS * 5);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
  });

  it("changes nothing on a stop while no list has carried the flag", async () => {
    vi.useFakeTimers();
    mocks.fetchRecovery.mockResolvedValue(ok([entry("refs/instafy/recovery/x/a", { origin: LIVE })]));
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    setUnsavedWorkLiveOrigins("p", [LIVE]);
    setUnsavedWorkLiveOrigins("p", []);
    await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS * 5);
    await microtasks();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);
    expect(getRollingSaveScope("p").hidden.size).toBe(0);
    expect(visible()).toBe(getUnsavedWorkSnapshot("p", "o").entries);
  });

  it("lists nothing again for a project that never loaded a list, or after a switch", async () => {
    vi.useFakeTimers();
    mocks.fetchRecovery.mockResolvedValue(ok([rollingSave("folder-1", LIVE)]));
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    // Another project: its stop has no list to fetch.
    setUnsavedWorkLiveOrigins("q", [LIVE]);
    setUnsavedWorkLiveOrigins("q", []);
    await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS * 2);
    await microtasks();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    // A stop, then a switch before the list is fetched again: dropped.
    setUnsavedWorkLiveOrigins("p", [LIVE]);
    setUnsavedWorkLiveOrigins("p", []);
    setUnsavedWorkLiveOrigins("q", null);
    await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS * 2);
    await microtasks();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);
  });
});

describe("useUnsavedWork", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseUnsavedWorkResult | null = null;

  function Probe(props: {
    projectId: string | null;
    originId: string | null;
    enabled: boolean;
    mountRefresh?: "reuse" | "force";
  }) {
    latest = useUnsavedWork(props);
    return null;
  }

  function Publisher(props: {
    projectId: string | null;
    answer: { projectId: string; statuses: ControllerRuntimeStatusEntry[] } | null;
  }) {
    usePublishUnsavedWorkLiveOrigins(props);
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetUnsavedWorkStoreForTests();
    mocks.fetchRecovery.mockReset();
    mocks.fetchRecovery.mockResolvedValue(ok([entry("refs/instafy/recovery/x/a")]));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("never lists when disabled (legacy spaces)", async () => {
    await act(async () => root.render(<Probe projectId="p" originId="o" enabled={false} />));
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.fetchRecovery).not.toHaveBeenCalled();
    expect(latest?.status).toBe("idle");
  });

  it("lists on mount and again on focus only when the list is older than five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
    await act(async () => root.render(<Probe projectId="p" originId="o" enabled />));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);
    expect(latest?.entries).toHaveLength(1);

    vi.setSystemTime(new Date(Date.now() + 60_000));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + UNSAVED_WORK_FOCUS_REFRESH_MS));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
  });

  it("reuses a fresh list on mount unless the mount forces one (the drawer opening)", async () => {
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    await act(async () => root.render(<Probe projectId="p" originId="o" enabled />));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Probe projectId="p" originId="o" enabled mountRefresh="force" />));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
  });

  it("leaves a live origin's rolling save out until it stops, then lists again and shows it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unpublished = entry(`refs/instafy/recovery/${LIVE}/run-1`, { origin: LIVE });
    mocks.fetchRecovery.mockResolvedValue(ok([unpublished, rollingSave("folder-1", LIVE, "1")]));
    const view = (answer: { projectId: string; statuses: ControllerRuntimeStatusEntry[] } | null) => (
      <>
        <Publisher projectId="p" answer={answer} />
        <Probe projectId="p" originId="o" enabled />
      </>
    );

    // Before the runtime status answers, no rolling save shows.
    await act(async () => root.render(view(null)));
    await flush();
    expect(latest?.entries).toHaveLength(2);
    expect(refsOf(latest?.visibleEntries ?? [])).toEqual([unpublished.ref]);

    await act(async () => root.render(view({ projectId: "p", statuses: [runtimeStatus(LIVE)] })));
    await flush();
    expect(refsOf(latest?.visibleEntries ?? [])).toEqual([unpublished.ref]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    mocks.fetchRecovery.mockResolvedValue(ok([unpublished, rollingSave("folder-1", LIVE, "2")]));
    await act(async () => root.render(view({ projectId: "p", statuses: [] })));
    await flush();
    expect(refsOf(latest?.visibleEntries ?? [])).toEqual([unpublished.ref]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    });
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(latest?.visibleEntries.map((item) => item.rev)).toEqual([
      unpublished.rev,
      rollingSave("folder-1", LIVE, "2").rev,
    ]);
  });

  it("counts only a status answer for the current project, and keeps it while no new one arrives", async () => {
    const fromP = { projectId: "p", statuses: [runtimeStatus(LIVE)] };
    await act(async () => root.render(<Publisher projectId="p" answer={fromP} />));
    expect(getRollingSaveScope("p").hidden.has(LIVE)).toBe(true);

    // The switch commits before the new project's status answers.
    await act(async () => root.render(<Publisher projectId="q" answer={fromP} />));
    expect(getRollingSaveScope("q").known).toBe(false);
    await act(async () => root.render(<Publisher projectId="q" answer={null} />));
    expect(getRollingSaveScope("q").known).toBe(false);

    const fromQ = { projectId: "q", statuses: [runtimeStatus(OTHER)] };
    await act(async () => root.render(<Publisher projectId="q" answer={fromQ} />));
    expect(getRollingSaveScope("q").known).toBe(true);
    expect(getRollingSaveScope("q").hidden.has(OTHER)).toBe(true);
    expect(getRollingSaveScope("q").hidden.has(LIVE)).toBe(false);

    // A failed or skipped refresh leaves the answer: the set stays as it was.
    await act(async () => root.render(<Publisher projectId="q" answer={{ ...fromQ }} />));
    expect(getRollingSaveScope("q").hidden.has(OTHER)).toBe(true);
  });

  it("lists again for a new project", async () => {
    await act(async () => root.render(<Probe projectId="p" originId="o" enabled />));
    await flush();
    await act(async () => root.render(<Probe projectId="q" originId="o" enabled />));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenNthCalledWith(2, { projectId: "q", originId: "o" });
  });
});
