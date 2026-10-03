// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, ListMyActivityResult } from "../../../services/runtimeController/activity";
import { useHomeActivity } from "../useHomeActivity";

const { list, markSeen } = vi.hoisted(() => ({ list: vi.fn(), markSeen: vi.fn() }));
vi.mock("../../../sdk/instafy", () => ({ controllerClient: { activity: { list, markSeen } } }));

function item(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id, kind: "conversation.reply", at: "2026-09-06T12:00:00.000Z",
    project: { id: "project", name: "Space" }, org: null, conversation: null, run: null,
    actor: { kind: "agent", userId: null, displayName: null, handle: null, avatarSeed: null },
    title: "Reply", preview: null, needsYou: true, live: false, seen: false, data: {}, ...patch,
  };
}

function page(ids: string[], patch: Partial<ListMyActivityResult> = {}): ListMyActivityResult {
  return { success: true, items: ids.map((id) => item(id)), hasMore: false, nextBefore: null, ...patch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("useHomeActivity", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useHomeActivity>;

  function Harness({ userId, shouldMarkSeen, restorePages }: { userId: string | null; shouldMarkSeen: boolean; restorePages: number }) {
    current = useHomeActivity(userId, 2, shouldMarkSeen, restorePages);
    return <div>{current.activityItems.map((entry) => entry.id).join(",")}</div>;
  }
  const render = async (userId: string | null = "user-a", shouldMarkSeen = true, restorePages = 1) => {
    await act(async () => root.render(<Harness userId={userId} shouldMarkSeen={shouldMarkSeen} restorePages={restorePages} />));
  };
  const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); };
  const loadMore = async () => {
    let loaded = false;
    await act(async () => { loaded = await current.loadMoreActivity(); });
    return loaded;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.resetAllMocks();
    markSeen.mockResolvedValue({ success: true });
    list.mockResolvedValue(page([]));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps older history reachable even when loaded rows belong to another team", async () => {
    list.mockResolvedValueOnce(page(["12", "11"], { hasMore: true, nextBefore: "11" }));
    list.mockResolvedValueOnce(page(["10"], { items: [item("10", { org: { id: "other-team", name: "Other" } })] }));
    await render();
    expect(current.activityItems.filter((entry) => entry.org?.id === "other-team")).toHaveLength(0);
    expect(current.activityHasMore).toBe(true);
    expect(await loadMore()).toBe(true);
    expect(list).toHaveBeenLastCalledWith({ before: "11", limit: 2 });
    expect(current.activityItems.filter((entry) => entry.org?.id === "other-team")).toHaveLength(1);
    expect(current.activityHasMore).toBe(false);
  });

  it("re-reads saved Home pages with current permissions instead of restoring cached rows", async () => {
    list.mockResolvedValueOnce(page(["20"], { hasMore: true, nextBefore: "20" }));
    list.mockResolvedValueOnce(page(["18"], { hasMore: true, nextBefore: "18" }));
    list.mockResolvedValueOnce(page(["16"]));
    await render("user-a", true, 3);
    expect(list.mock.calls.map(([params]) => params)).toEqual([{ limit: 4 }, { before: "20", limit: 2 }, { before: "18", limit: 2 }]);
    expect(current.activityPages).toBe(3);
    expect(current.activityItems.map(entry => entry.id)).toEqual(["20", "18", "16"]);
    list.mockResolvedValueOnce(page(["9"]));
    await render("user-b", true, 3);
    expect(current.activityItems.map(entry => entry.id)).toEqual(["9"]);
    expect(current.activityPages).toBe(1);
  });

  it("guards repeated pagination clicks and retains a failed page for retry", async () => {
    list.mockResolvedValueOnce(page(["12"], { hasMore: true, nextBefore: "12" }));
    const pending = deferred<ListMyActivityResult>();
    list.mockReturnValueOnce(pending.promise);
    await render();
    let first!: Promise<boolean>;
    await act(async () => { first = current.loadMoreActivity(); });
    expect(current.activityLoadingMore).toBe(true);
    expect(await loadMore()).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve({ success: false, error: "Temporary failure" }); await first; });
    expect(current.activityLoadingMore).toBe(false);
    expect(current.activityError).toBe("Temporary failure");
    expect(current.activityHasMore).toBe(true);
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["12"]);
    list.mockResolvedValueOnce(page(["11"]));
    await act(async () => { expect(await current.retryActivity()).toBe(true); });
    expect(list).toHaveBeenLastCalledWith({ before: "12", limit: 2 });
    expect(current.activityError).toBeNull();
  });

  it("captures the previous-visit cut once while refreshing overlapping rows", async () => {
    list.mockResolvedValueOnce(page(["9007199254740993"], { lastSeenEventId: "7" }));
    list.mockResolvedValueOnce(page([], {
      items: [item("9007199254740994"), item("9007199254740993", { title: "Updated", needsYou: false })],
      lastSeenEventId: "9007199254740993",
    }));
    await render();
    await tick();
    expect(list).toHaveBeenLastCalledWith({ since: "9007199254740993", limit: 200 });
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["9007199254740994", "9007199254740993"]);
    expect(current.activityItems[1]).toMatchObject({ title: "Updated", needsYou: false });
    expect(current.serverLastSeenEventId).toBe("7");
    expect(markSeen.mock.calls.map(([params]) => params.lastSeenEventId)).toEqual(["9007199254740993", "9007199254740994"]);
  });

  it("resumes a bounded catch-up gap on the next tick before advancing the since cursor", async () => {
    list.mockResolvedValueOnce(page(["10"], { hasMore: true, nextBefore: "10" }));
    for (const ids of [["500", "400"], ["399", "300"], ["299", "200"], ["199", "100"]]) {
      list.mockResolvedValueOnce(page(ids, { hasMore: true, nextBefore: ids[1] }));
    }
    list.mockResolvedValueOnce(page(["99", "10"], { hasMore: true, nextBefore: "10" }));
    list.mockResolvedValueOnce(page(["501", "500"]));
    await render();
    await tick();
    expect(list).toHaveBeenCalledTimes(5);
    expect(list).toHaveBeenLastCalledWith({ before: "200", limit: 200 });
    await tick();
    expect(list).toHaveBeenCalledTimes(6);
    expect(list).toHaveBeenLastCalledWith({ before: "100", limit: 200 });
    expect(current.activityItems.some((entry) => entry.id === "99")).toBe(true);
    await tick();
    expect(list).toHaveBeenLastCalledWith({ since: "500", limit: 200 });
    expect(current.activityHasMore).toBe(true);
    expect(markSeen.mock.calls.map(([params]) => params.lastSeenEventId)).toEqual(["10", "500", "501"]);
  });

  it("does not start overlapping polls and retries a refresh failure using since", async () => {
    list.mockResolvedValueOnce(page(["10"], { hasMore: true, nextBefore: "10" }));
    const pending = deferred<ListMyActivityResult>();
    list.mockReturnValueOnce(pending.promise);
    await render();
    await tick();
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve({ success: false, error: "Offline" }); });
    expect(current.activityError).toBe("Offline");
    list.mockResolvedValueOnce(page(["11"]));
    await act(async () => { expect(await current.retryActivity()).toBe(true); });
    expect(list).toHaveBeenLastCalledWith({ since: "10", limit: 200 });
    expect(current.activityError).toBeNull();
    expect(current.activityHasMore).toBe(true);
  });

  it("keeps a failed catch-up visible while loading older history and retries the missing gap", async () => {
    list.mockResolvedValueOnce(page(["10"], { hasMore: true, nextBefore: "10" }));
    list.mockResolvedValueOnce(page(["30", "20"], { hasMore: true, nextBefore: "20" }));
    list.mockResolvedValueOnce({ success: false, error: "Refresh interrupted" });
    await render();
    await tick();
    expect(list).toHaveBeenLastCalledWith({ before: "20", limit: 200 });
    expect(current.activityError).toBe("Refresh interrupted");

    list.mockResolvedValueOnce(page(["9"]));
    expect(await loadMore()).toBe(true);
    expect(list).toHaveBeenLastCalledWith({ before: "10", limit: 2 });
    expect(current.activityError).toBe("Refresh interrupted");
    expect(current.activityHasMore).toBe(false);

    list.mockResolvedValueOnce(page(["19", "10"], { hasMore: true, nextBefore: "10" }));
    await act(async () => { expect(await current.retryActivity()).toBe(true); });
    expect(list).toHaveBeenLastCalledWith({ before: "20", limit: 200 });
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["30", "20", "19", "10", "9"]);
    expect(current.activityError).toBeNull();
    expect(current.activityHasMore).toBe(false);
  });

  it("retries the initial request and captures its pagination and visit cut", async () => {
    list.mockRejectedValueOnce(new Error("Network interrupted"));
    list.mockResolvedValueOnce(page(["12"], { hasMore: true, nextBefore: "12", lastSeenEventId: "4" }));
    await render();
    expect(current.activityLoading).toBe(false);
    expect(current.activityError).toBe("Network interrupted");
    await act(async () => { expect(await current.retryActivity()).toBe(true); });
    expect(list).toHaveBeenLastCalledWith({ limit: 4 });
    expect(current.activityHasMore).toBe(true);
    expect(current.serverLastSeenEventId).toBe("4");
    expect(current.activityError).toBeNull();
  });

  it("updates pagination when activity first appears after an empty initial response", async () => {
    list.mockResolvedValueOnce(page([], { lastSeenEventId: "0" }));
    list.mockResolvedValueOnce(page(["20", "19"], { hasMore: true, nextBefore: "19" }));
    await render();
    await tick();
    expect(current.activityHasMore).toBe(true);
    list.mockResolvedValueOnce(page(["18"]));
    expect(await loadMore()).toBe(true);
    expect(list).toHaveBeenLastCalledWith({ before: "19", limit: 2 });
    expect(current.serverLastSeenEventId).toBe("0");
  });

  it("isolates late initial responses and clears stale cursors when the signed-in user changes", async () => {
    const old = deferred<ListMyActivityResult>();
    list.mockReturnValueOnce(old.promise);
    list.mockResolvedValueOnce(page(["2"], { lastSeenEventId: "1" }));
    await render();
    await render("user-b");
    await act(async () => { old.resolve(page(["99"], { hasMore: true, nextBefore: "99", lastSeenEventId: "98" })); });
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["2"]);
    expect(current.serverLastSeenEventId).toBe("1");
    expect(current.activityHasMore).toBe(false);
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(markSeen).toHaveBeenLastCalledWith({ lastSeenEventId: "2" });
  });

  it("ignores late older-history requests and stale actions after changing users", async () => {
    list.mockResolvedValueOnce(page(["99"], { hasMore: true, nextBefore: "99" }));
    const old = deferred<ListMyActivityResult>();
    list.mockReturnValueOnce(old.promise);
    list.mockResolvedValueOnce(page(["3"], { lastSeenEventId: "2" }));
    await render();
    const staleLoadMore = current.loadMoreActivity;
    let pending!: Promise<boolean>;
    await act(async () => { pending = current.loadMoreActivity(); });
    await render("user-b");
    await act(async () => { old.resolve(page(["98"])); expect(await pending).toBe(false); });
    expect(await staleLoadMore()).toBe(false);
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["3"]);
    expect(current.activityLoadingMore).toBe(false);
    expect(current.serverLastSeenEventId).toBe("2");
  });

  it("stops polling and exposes no activity when signed out", async () => {
    list.mockResolvedValueOnce(page(["9"]));
    await render();
    await render(null);
    await tick();
    expect(list).toHaveBeenCalledTimes(1);
    expect(current.activityItems).toEqual([]);
    expect(current.activityLoading).toBe(false);
    expect(await current.loadMoreActivity()).toBe(false);
    expect(await current.retryActivity()).toBe(false);
  });

  it("loads, paginates, polls and retries Team activity without advancing the Home seen cursor", async () => {
    list.mockResolvedValueOnce(page(["12", "11"], { hasMore: true, nextBefore: "11", lastSeenEventId: "4" }));
    list.mockResolvedValueOnce(page(["10"]));
    list.mockResolvedValueOnce({ success: false, error: "Refresh interrupted" });
    list.mockResolvedValueOnce(page(["13"], { lastSeenEventId: "8" }));
    await render("user-a", false);
    expect(await loadMore()).toBe(true);
    await tick();
    expect(current.activityError).toBe("Refresh interrupted");
    await act(async () => { expect(await current.retryActivity()).toBe(true); });
    expect(list.mock.calls.map(([params]) => params)).toEqual([
      { limit: 4 }, { before: "11", limit: 2 },
      { since: "12", limit: 200 }, { since: "12", limit: 200 },
    ]);
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["13", "12", "11", "10"]);
    expect(current.serverLastSeenEventId).toBe("4");
    expect(current.activityError).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("does not mark a canceled Home response after switching to a read-only Team visit", async () => {
    const pendingHome = deferred<ListMyActivityResult>();
    list.mockReturnValueOnce(pendingHome.promise);
    list.mockResolvedValueOnce(page(["12"], { lastSeenEventId: "4" }));
    await render();
    await render("user-a", false);
    await act(async () => { pendingHome.resolve(page(["99"])); });
    expect(current.activityItems.map((entry) => entry.id)).toEqual(["12"]);
    expect(markSeen).not.toHaveBeenCalled();

    list.mockResolvedValueOnce(page(["13"], { lastSeenEventId: "4" }));
    await render("user-a", true);
    expect(markSeen).toHaveBeenCalledExactlyOnceWith({ lastSeenEventId: "13" });
  });
});
