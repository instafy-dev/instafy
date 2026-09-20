import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControllerMessageSearchMatch, ControllerMessageSearchParams } from "@instafy/sdk/conversation-search";
import { controllerClient } from "../../sdk/instafy";
import { ControllerMessageSearchError } from "../../services/runtimeController/messageSearch";
import type { StudioSearchScope } from "./components/useStudioSearch";

interface MessageSearchOptions {
  viewerUserId: string | null;
  enabled: boolean;
  query: string;
  scope: StudioSearchScope;
  orgId: string | null;
  spaceId: string | null;
  revision: number;
  restoreMessagePages?: number;
}

interface MessageSnapshot {
  generation: object;
  matches: ControllerMessageSearchMatch[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  pageCount: number;
  error: string | null;
}

const empty = (generation: object, loading: boolean): MessageSnapshot => ({
  generation, matches: [], loading, loadingMore: false, nextCursor: null, hasMore: false, pageCount: 0, error: null,
});

/** Fetch only matching excerpts. Search never hydrates chats or wakes a workspace. */
export function useStudioMessageSearch({ viewerUserId, enabled, query, scope, orgId, spaceId, revision, restoreMessagePages = 1 }: MessageSearchOptions) {
  const trimmedQuery = query.trim();
  const characterCount = Array.from(trimmedQuery).length;
  const canSearch = enabled && Boolean(viewerUserId) && characterCount >= 2 && characterCount <= 200;
  const key = JSON.stringify([canSearch, viewerUserId, trimmedQuery, scope, orgId, spaceId, revision]);
  // A new identity also isolates A → B → A, even when B's request is unresolved.
  const generation = useMemo(() => ({ key }), [key]);
  const liveGeneration = useRef(generation);
  liveGeneration.current = generation;
  const restoreCount = useRef(restoreMessagePages);
  restoreCount.current = restoreMessagePages;
  const [snapshot, setSnapshot] = useState(() => empty(generation, canSearch));
  const session = useRef<{ generation: object; loadMore: () => void } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let current = empty(generation, canSearch);
    let inFlight = false;
    const isCurrent = () => !abort.signal.aborted && liveGeneration.current === generation;
    const update = (patch: Partial<MessageSnapshot>) => {
      if (!isCurrent()) return;
      current = { ...current, ...patch };
      setSnapshot(current);
    };
    setSnapshot(current);
    if (!canSearch) return () => abort.abort();
    const params: ControllerMessageSearchParams = {
      query: trimmedQuery, limit: 30, signal: abort.signal,
      ...(scope === "space" && spaceId ? { projectId: spaceId } : {}),
      ...(scope !== "all" && orgId ? orgId === "personal" ? { personal: true } : { orgId } : {}),
    };
    const load = async (cursor?: string, restoring = false) => {
      if (!isCurrent() || inFlight) return;
      inFlight = true;
      update({ loading: !cursor || restoring, loadingMore: Boolean(cursor) && !restoring, error: null });
      try {
        const page = await controllerClient.search.messages({ ...params, ...(cursor ? { cursor } : {}) });
        if (!isCurrent()) return;
        if (page.hasMore && page.nextCursor === cursor) throw new Error("Unable to load the next message results. Retry search.");
        const seen = new Set(current.matches.map((row) => `${row.projectId}:${row.conversationId}:${row.messageId}`));
        const matches = page.matches.filter((row) => {
          if (scope === "space" && row.projectId !== spaceId || scope !== "all" && (row.orgId ?? "personal") !== orgId) return false;
          const id = `${row.projectId}:${row.conversationId}:${row.messageId}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        update({ matches: [...current.matches, ...matches], hasMore: page.hasMore,
          nextCursor: page.nextCursor, pageCount: current.pageCount + 1 });
      } catch (error) {
        if (!isCurrent()) return;
        const accessChanged = error instanceof ControllerMessageSearchError && (error.status === 401 || error.status === 403);
        update({ ...(accessChanged ? empty(generation, false) : {}),
          error: error instanceof Error ? error.message : "Unable to search messages. Retry search." });
      } finally {
        inFlight = false;
        update({ loading: false, loadingMore: false });
      }
    };
    session.current = { generation, loadMore: () => {
      if (current.hasMore && current.nextCursor) void load(current.nextCursor);
    } };
    const timer = window.setTimeout(() => {
      void (async () => {
        await load(undefined, true);
        const requestedPages = Number.isFinite(restoreCount.current) ? Math.max(1, Math.floor(restoreCount.current)) : 1;
        while (isCurrent() && !current.error && current.hasMore && current.nextCursor && current.pageCount < requestedPages) {
          await load(current.nextCursor, true);
        }
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
      if (session.current?.generation === generation) session.current = null;
    };
  }, [canSearch, generation, orgId, scope, spaceId, trimmedQuery]);

  const loadMore = useCallback(() => {
    if (session.current?.generation === liveGeneration.current) session.current.loadMore();
  }, []);
  const current = snapshot.generation === generation && canSearch ? snapshot : empty(generation, canSearch);
  const error = enabled && characterCount > 200 ? "Use up to 200 characters to search messages." : current.error;
  return { ...current, error, loadMore };
}
