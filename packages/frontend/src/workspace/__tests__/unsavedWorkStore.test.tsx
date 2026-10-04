// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchRecovery: vi.fn() }));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { fetchRecovery: mocks.fetchRecovery } } },
}));

import {
  getUnsavedWorkSnapshot,
  patchUnsavedWorkEntries,
  pendingUnsavedWorkEntries,
  refreshUnsavedWork,
  resetUnsavedWorkStoreForTests,
  UNSAVED_WORK_FOCUS_REFRESH_MS,
  useUnsavedWork,
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
    dismissible: true,
    ...extra,
  };
}

function ok(entries: unknown[]) {
  return { status: "ok", entries, originId: "o", originMode: "hosted" };
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
      ok([entry("refs/instafy/recovery/x/a"), entry("refs/instafy/salvage/gateway/b", { restoredRev: "f".repeat(40) })]),
    );
    await refreshUnsavedWork({ projectId: "p", originId: "o" });
    expect(pendingUnsavedWorkEntries(getUnsavedWorkSnapshot("p", "o").entries)).toHaveLength(1);
    patchUnsavedWorkEntries("p", "o", (entries) => entries.filter((item) => item.ref !== "refs/instafy/recovery/x/a"));
    expect(getUnsavedWorkSnapshot("p", "o").entries.map((item) => item.ref)).toEqual([
      "refs/instafy/salvage/gateway/b",
    ]);
  });
});

describe("useUnsavedWork", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseUnsavedWorkResult | null = null;

  function Probe(props: { projectId: string | null; originId: string | null; enabled: boolean }) {
    latest = useUnsavedWork(props);
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

  it("lists again for a new project", async () => {
    await act(async () => root.render(<Probe projectId="p" originId="o" enabled />));
    await flush();
    await act(async () => root.render(<Probe projectId="q" originId="o" enabled />));
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenNthCalledWith(2, { projectId: "q", originId: "o" });
  });
});
