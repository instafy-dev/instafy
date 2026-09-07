import { useCallback, useEffect, useRef, useState } from "react";
import { controllerClient } from "../../sdk/instafy";
import type { ActivityItem, ListMyActivityResult } from "../../services/runtimeController/activity";

const ACTIVITY_POLL_MS = 20_000;
const CATCH_UP_MAX_PAGES = 4;
const CATCH_UP_PAGE_SIZE = 200;

function numericCursor(value: string | null): bigint | null {
  try {
    return value === null ? null : BigInt(value);
  } catch {
    return null;
  }
}

function newestActivityId(items: ActivityItem[]): string | null {
  let newest: bigint | null = null;
  for (const item of items) {
    const id = numericCursor(item.id);
    if (id !== null && (newest === null || id > newest)) newest = id;
  }
  return newest?.toString() ?? null;
}

function mergeActivity(current: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
  // Catch-up overlaps earlier pages. Refresh repeated rows as their run,
  // unread state and conversation title may have changed on the controller.
  const merged = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => merged.set(item.id, item));
  return [...merged.values()].sort((a, b) => {
    const left = numericCursor(a.id);
    const right = numericCursor(b.id);
    return left === null || right === null || left === right ? 0 : left > right ? -1 : 1;
  });
}

interface ActivityState {
  viewerUserId: string | null;
  activityItems: ActivityItem[];
  activityLoading: boolean;
  activityLoadingMore: boolean;
  activityHasMore: boolean;
  activityError: string | null;
  serverLastSeenEventId: string | null;
}

function initialState(viewerUserId: string | null): ActivityState {
  return {
    viewerUserId,
    activityItems: [],
    activityLoading: viewerUserId !== null,
    activityLoadingMore: false,
    activityHasMore: false,
    activityError: null,
    serverLastSeenEventId: null,
  };
}

/** One Home visit's ledger and previous-visit cut, isolated to the signed-in user. */
export function useHomeActivity(viewerUserId: string | null, pageSize = 24) {
  const [state, setState] = useState(() => initialState(viewerUserId));
  const actionsRef = useRef<{
    viewerUserId: string;
    loadMore: () => Promise<boolean>;
    retry: () => Promise<boolean>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let snapshot = initialState(viewerUserId);
    let initialized = false;
    let firstLoading = false;
    let polling = false;
    let nextBefore: string | null = null;
    let seenAdvancedTo: bigint | null = null;
    let catchUp: { before: string; boundary: bigint } | null = null;
    let failedRequest: "first" | "more" | "poll" | null = null;
    setState(snapshot);
    if (!viewerUserId) {
      actionsRef.current = null;
      return;
    }

    const update = (patch: Partial<ActivityState>) => {
      if (cancelled) return;
      snapshot = { ...snapshot, ...patch };
      setState(snapshot);
    };
    const advanceSeen = () => {
      const newest = numericCursor(newestActivityId(snapshot.activityItems));
      if (newest === null || (seenAdvancedTo !== null && newest <= seenAdvancedTo)) return;
      seenAdvancedTo = newest;
      void controllerClient.activity.markSeen({ lastSeenEventId: newest.toString() })
        .then((result) => {
          if (!cancelled && !result.success && seenAdvancedTo === newest) seenAdvancedTo = null;
        })
        .catch(() => {
          if (!cancelled && seenAdvancedTo === newest) seenAdvancedTo = null;
        });
    };
    const mergePage = (result: ListMyActivityResult) => {
      update({ activityItems: mergeActivity(snapshot.activityItems, result.items ?? []) });
      advanceSeen();
    };
    const recordError = (error: unknown, request: "first" | "more" | "poll") => {
      failedRequest = request;
      update({ activityError: error instanceof Error ? error.message : String(error) });
    };
    const clearError = (request: "first" | "more" | "poll") => {
      if (failedRequest !== request) return;
      failedRequest = null;
      update({ activityError: null });
    };
    const loadFirstPage = async (): Promise<boolean> => {
      if (cancelled || firstLoading) return false;
      firstLoading = true;
      update({ activityLoading: true, activityError: null });
      try {
        const result = await controllerClient.activity.list({ limit: pageSize * 2 });
        if (cancelled) return false;
        if (!result.success) {
          recordError(result.error ?? "Unable to load activity.", "first");
          return false;
        }
        initialized = true;
        nextBefore = result.nextBefore ?? null;
        update({
          activityItems: mergeActivity([], result.items ?? []),
          activityHasMore: result.hasMore === true && nextBefore !== null,
          // Freeze this visit's divider even when polling advances the server marker.
          serverLastSeenEventId: result.lastSeenEventId ?? null,
        });
        advanceSeen();
        clearError("first");
        return true;
      } catch (error) {
        recordError(error, "first");
        return false;
      } finally {
        firstLoading = false;
        update({ activityLoading: false });
      }
    };

    const loadMore = async (): Promise<boolean> => {
      if (cancelled || snapshot.activityLoadingMore || firstLoading) return false;
      if (!initialized) return loadFirstPage();
      if (!snapshot.activityHasMore || !nextBefore) return false;
      const before = nextBefore;
      // Paging history does not recover an interrupted refresh. Keep that
      // error (and its Retry action) until the missing catch-up succeeds.
      update({ activityLoadingMore: true });
      try {
        const result = await controllerClient.activity.list({ before, limit: pageSize });
        if (cancelled) return false;
        if (!result.success) {
          recordError(result.error ?? "Unable to load older activity.", "more");
          return false;
        }
        nextBefore = result.nextBefore ?? null;
        mergePage(result);
        update({ activityHasMore: result.hasMore === true && nextBefore !== null && nextBefore !== before });
        clearError("more");
        return true;
      } catch (error) {
        recordError(error, "more");
        return false;
      } finally {
        update({ activityLoadingMore: false });
      }
    };

    const poll = async (): Promise<boolean> => {
      if (cancelled || polling || firstLoading) return false;
      if (!initialized) return loadFirstPage();
      polling = true;
      try {
        const boundary = catchUp?.boundary ?? numericCursor(newestActivityId(snapshot.activityItems));
        let before = catchUp?.before;
        for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
          const result = await controllerClient.activity.list(
            before ? { before, limit: CATCH_UP_PAGE_SIZE }
              : boundary !== null ? { since: boundary.toString(), limit: CATCH_UP_PAGE_SIZE }
                : { limit: pageSize * 2 },
          );
          if (cancelled) return false;
          if (!result.success) {
            recordError(result.error ?? "Unable to refresh activity.", "poll");
            return false;
          }
          mergePage(result);
          if (boundary === null) {
            nextBefore = result.nextBefore ?? null;
            update({ activityHasMore: result.hasMore === true && nextBefore !== null });
          }
          const cursor = numericCursor(result.nextBefore ?? null);
          // Both API modes return newest first. Stop at our old newest row,
          // rather than wandering into history because the API includes overlap.
          // Retain an unfinished gap across ticks; moving straight to the new
          // newest cursor after the page budget would permanently skip rows.
          if (boundary === null || !result.hasMore || cursor === null || cursor <= boundary
            || result.nextBefore === before || (result.items ?? []).length === 0) {
            catchUp = null;
            clearError("poll");
            return true;
          }
          before = result.nextBefore!;
          catchUp = { before, boundary };
        }
        clearError("poll");
        return true;
      } catch (error) {
        recordError(error, "poll");
        return false;
      } finally {
        polling = false;
      }
    };

    actionsRef.current = {
      viewerUserId,
      loadMore,
      retry: () => failedRequest === "more" ? loadMore() : poll(),
    };
    void loadFirstPage();
    const timer = window.setInterval(() => { void poll(); }, ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      actionsRef.current = null;
      window.clearInterval(timer);
    };
  }, [pageSize, viewerUserId]);

  const loadMoreActivity = useCallback(() => {
    const actions = actionsRef.current;
    return actions?.viewerUserId === viewerUserId ? actions.loadMore() : Promise.resolve(false);
  }, [viewerUserId]);
  const retryActivity = useCallback(() => {
    const actions = actionsRef.current;
    return actions?.viewerUserId === viewerUserId ? actions.retry() : Promise.resolve(false);
  }, [viewerUserId]);

  // Do not expose the previous user's rows during the render before effect cleanup.
  const current = state.viewerUserId === viewerUserId ? state : initialState(viewerUserId);
  return { ...current, loadMoreActivity, retryActivity };
}
