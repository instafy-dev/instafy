import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationState } from "../../conversations/conversationState";
import {
  extractConversationLocalIdFromMetadata,
  extractConversationLifecycleFromMetadata,
  extractConversationTitleFromMetadata,
} from "../../conversations/conversationMetadata";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../../projects/projectAccessEvents";
import type { ProjectListItem } from "../../projects/useProjects";
import { controllerClient, type ControllerProjectConversation, type ControllerProjectSummary } from "../../sdk/instafy";
import type { StudioSearchRecord, StudioSearchScope } from "./components/useStudioSearch";
import { isSafeStudioFilePath, type StudioKnownFile } from "./useStudioKnownFiles";
import { useStudioMessageSearch } from "./useStudioMessageSearch";

const CHAT_LIMIT = 200;
const SPACE_LIMIT = 40;
const CONCURRENT_READS = 4;

export type StudioSearchTarget =
  | { kind: "conversation"; projectId: string; conversationId: string | null; conversationControllerId: string | null; messageId?: string }
  | { kind: "file"; projectId: string; path: string; fileId: string; requiresLoad?: boolean }
  | { kind: "space-panel"; projectId: string; panel: "settings" | "automations" }
  | { kind: "org-settings"; orgId: string };

export interface StudioSearchRecordsOptions {
  viewerUserId: string | null;
  enabled: boolean;
  query?: string;
  restoreMessagePages?: number;
  scope: StudioSearchScope;
  /** Personal spaces use the same "personal" key as the navigation rail. */
  orgId: string | null;
  spaceId: string | null;
  projects: readonly ProjectListItem[];
  knownFiles?: readonly StudioKnownFile[];
  activeConversations: {
    projectId: string;
    items: readonly (Pick<ConversationState, "localId" | "controllerId" | "title"> & Partial<Pick<ConversationState, "lifecycleStatus" | "createdAt">>)[];
  } | null;
  onActivate: (target: StudioSearchTarget) => void;
}

interface SearchSnapshot {
  key: string;
  projects: ControllerProjectSummary[];
  conversations: Record<string, ControllerProjectConversation[]>;
  loading: boolean;
  error: string | null;
  limitedSpaces: boolean;
}

function emptySnapshot(key: string, loading: boolean): SearchSnapshot {
  return { key, projects: [], conversations: {}, loading, error: null, limitedSpaces: false };
}

function chatActivityTimestamp(chat: ControllerProjectConversation): number {
  for (const value of [chat.lastMessageAt, chat.updatedAt, chat.createdAt]) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

/** Search does not open origins or start runtimes: files are already-known paths only. */
export function useStudioSearchRecords({
  viewerUserId, enabled, query = "", restoreMessagePages, scope, orgId, spaceId, projects, knownFiles, activeConversations, onActivate,
}: StudioSearchRecordsOptions) {
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const scopeReady = scope === "all" || Boolean(orgId && (scope === "org" || spaceId));
  const canSearch = enabled && Boolean(viewerUserId) && scopeReady;
  const key = JSON.stringify([canSearch, viewerUserId, scope, orgId, spaceId, revision]);
  const [snapshot, setSnapshot] = useState(() => emptySnapshot(key, canSearch));
  const messages = useStudioMessageSearch({ viewerUserId, enabled: canSearch, query, scope, orgId, spaceId, revision, restoreMessagePages });

  useEffect(() => {
    if (!canSearch) return;
    const refreshWhenVisible = () => { if (document.visibilityState !== "hidden") retry(); };
    window.addEventListener(PROJECT_ACCESS_REFRESH_EVENT, retry);
    window.addEventListener("instafy:controller-stream-reconnected", retry);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener(PROJECT_ACCESS_REFRESH_EVENT, retry);
      window.removeEventListener("instafy:controller-stream-reconnected", retry);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [canSearch, retry]);

  useEffect(() => {
    const abort = new AbortController();
    let current = emptySnapshot(key, canSearch);
    setSnapshot(current);
    if (!canSearch) return () => abort.abort();
    const update = (patch: Partial<SearchSnapshot>) => {
      if (abort.signal.aborted) return;
      current = { ...current, ...patch };
      setSnapshot(current);
    };
    const load = async () => {
      // Cached project metadata is useful for known file paths, but never grants access.
      const result = await controllerClient.projects.listResult({
        ...(scope !== "all" && orgId && orgId !== "personal" ? { orgId } : {}),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (result.status !== "success") {
        update({ loading: false, error: "Unable to load accessible spaces. Retry search." });
        return;
      }
      const seen = new Set<string>();
      const accessible = result.projects.filter((project) => {
        if (seen.has(project.projectId)) return false;
        seen.add(project.projectId);
        if (scope === "space") return project.projectId === spaceId && (project.orgId ?? "personal") === orgId;
        if (scope === "org") return (project.orgId ?? "personal") === orgId;
        return true;
      }).sort((left, right) => (left.projectName ?? "").localeCompare(right.projectName ?? "") || left.projectId.localeCompare(right.projectId));
      const selected = accessible.slice(0, SPACE_LIMIT);
      update({ projects: selected, limitedSpaces: accessible.length > SPACE_LIMIT });
      let next = 0;
      let failures = 0;
      const worker = async () => {
        while (!abort.signal.aborted && next < selected.length) {
          const project = selected[next++];
          try {
            const rows = await controllerClient.conversations.listForProject({ projectId: project.projectId, limit: CHAT_LIMIT, signal: abort.signal });
            if (abort.signal.aborted) return;
            if (rows === null) {
              failures += 1;
            } else {
              update({ conversations: {
                ...current.conversations,
                [project.projectId]: rows.filter((row) => row.projectId === project.projectId).slice(0, CHAT_LIMIT),
              } });
            }
          } catch {
            if (abort.signal.aborted) return;
            failures += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENT_READS, selected.length) }, worker));
      update({ loading: false, error: failures ? `Couldn’t load chats in ${failures === 1 ? "one space" : `${failures} spaces`}. Retry search.` : null });
    };
    void load().catch(() => update({ loading: false, error: "Unable to load accessible spaces. Retry search." }));
    return () => abort.abort();
  }, [canSearch, key, orgId, scope, spaceId]);

  // Account, scope, access refresh and close must hide the old index before effects run.
  const current = snapshot.key === key && canSearch ? snapshot : emptySnapshot(key, canSearch);
  const records = useMemo<StudioSearchRecord[]>(() => {
    if (!canSearch) return [];
    const output: StudioSearchRecord[] = [];
    const chatActivity = new Map<string, number>();
    for (const message of messages.matches) {
      const local = activeConversations?.projectId === message.projectId
        ? activeConversations.items.find((chat) => chat.controllerId === message.conversationId) : null;
      output.push({
        id: `message:${message.projectId}:${message.conversationId}:${message.messageId}`,
        title: message.conversationTitle.trim() || "Untitled chat",
        description: `${message.orgName?.trim() || (message.orgId ? "Team" : "Personal")} / ${message.projectName.trim() || "Untitled space"}`,
        keywords: "", group: "Messages", orgId: message.orgId ?? "personal", spaceId: message.projectId,
        message: { excerpt: message.snippet, query: query.trim(), matchRanges: message.matchRanges,
          authorLabel: message.role === "assistant" ? "Assistant" : "User", createdAt: message.createdAt },
        activate: () => onActivate({ kind: "conversation", projectId: message.projectId,
          conversationId: local?.localId ?? null, conversationControllerId: message.conversationId,
          messageId: message.messageId }),
      });
    }
    const knownProjects = new Map(projects.map((project) => [project.id, project]));
    const seenOrgs = new Set<string>();
    for (const project of current.projects) {
      const projectId = project.projectId;
      const projectOrgId = project.orgId ?? "personal";
      const orgName = project.orgName?.trim() || (project.orgId ? "Team" : "Personal");
      const name = project.projectName?.trim() || "Untitled space";
      const description = `${orgName} / ${name}`;
      const push = (record: Omit<StudioSearchRecord, "orgId" | "spaceId" | "description" | "activate">, target: StudioSearchTarget, activityAt = 0) => {
        output.push({ ...record, orgId: projectOrgId, spaceId: projectId, description, activate: () => onActivate(target) });
        if (record.group === "Chats") chatActivity.set(record.id, activityAt);
      };
      const remote = current.conversations[projectId];
      const local = activeConversations?.projectId === projectId ? activeConversations.items : [];
      const localByController = new Map(local.filter((chat) => chat.controllerId).map((chat) => [chat.controllerId, chat]));
      const seenChats = new Set<string>();
      for (const chat of remote ?? []) {
        if (!chat.id || seenChats.has(chat.id)) continue;
        seenChats.add(chat.id);
        const loaded = localByController.get(chat.id);
        const lifecycle = loaded?.lifecycleStatus ?? extractConversationLifecycleFromMetadata(chat.metadata, viewerUserId);
        if (lifecycle === "hidden" || lifecycle === "deleted") continue;
        push({ id: `chat:${projectId}:${chat.id}`, title: loaded?.title.trim() || extractConversationTitleFromMetadata(chat.metadata) || "Untitled chat", keywords: "chat conversation thread", group: "Chats" }, {
          kind: "conversation", projectId, conversationId: loaded?.localId ?? extractConversationLocalIdFromMetadata(chat.metadata), conversationControllerId: chat.id,
        }, chatActivityTimestamp(chat));
      }
      // Preserve newly created local chats, but do not resurrect cached private chats
      // that the controller no longer includes for this account.
      if (remote) for (const chat of local) {
        if (chat.controllerId || seenChats.has(chat.localId) || chat.lifecycleStatus === "hidden" || chat.lifecycleStatus === "deleted") continue;
        seenChats.add(chat.localId);
        push({ id: `chat:${projectId}:local:${chat.localId}`, title: chat.title.trim() || "New chat", keywords: "chat conversation thread", group: "Chats" }, {
          kind: "conversation", projectId, conversationId: chat.localId, conversationControllerId: null,
        }, typeof chat.createdAt === "number" && Number.isFinite(chat.createdAt) ? chat.createdAt : 0);
      }
      const seenPaths = new Set<string>();
      for (const file of knownProjects.get(projectId)?.state.code.files ?? []) {
        const path = file.path.replace(/\\/g, "/");
        if (file.kind === "directory" || file.kind === "other" || !isSafeStudioFilePath(path) || seenPaths.has(path)) continue;
        seenPaths.add(path);
        push({ id: `file:${projectId}:${path}`, title: path, keywords: "file source document", group: "Files" }, { kind: "file", projectId, path, fileId: file.id });
      }
      for (const file of knownFiles ?? []) {
        const { path } = file;
        if (file.projectId !== projectId || !isSafeStudioFilePath(path) || seenPaths.has(path)) continue;
        seenPaths.add(path);
        push({ id: `file:${projectId}:${path}`, title: path, keywords: "file source document", group: "Files" }, {
          kind: "file", projectId, path, fileId: file.fileId, requiresLoad: true,
        });
      }
      push({ id: `settings:${projectId}`, title: "Space settings", keywords: "settings configuration preferences", group: "Settings" }, { kind: "space-panel", projectId, panel: "settings" });
      push({ id: `automations:${projectId}`, title: "Open automations", keywords: "action automation jobs schedules", group: "Actions" }, { kind: "space-panel", projectId, panel: "automations" });
      if (project.orgId && !seenOrgs.has(project.orgId)) {
        seenOrgs.add(project.orgId);
        output.push({ id: `org-settings:${project.orgId}`, title: "Team settings", description: orgName, keywords: "settings organization team members profile", group: "Settings", orgId: project.orgId, spaceId: null, activate: () => onActivate({ kind: "org-settings", orgId: project.orgId! }) });
      }
    }
    // Keep the backend's message order and each non-chat surface stable. Equal
    // activity timestamps retain their source order through the stable sort.
    const chats = output.filter((record) => record.group === "Chats")
      .sort((left, right) => (chatActivity.get(right.id) ?? 0) - (chatActivity.get(left.id) ?? 0));
    let chatIndex = 0;
    return output.map((record) => record.group === "Chats" ? chats[chatIndex++] : record);
  }, [activeConversations, canSearch, current.conversations, current.projects, knownFiles, messages.matches, onActivate, projects, query, viewerUserId]);
  const notice = `Message search matches text in accessible conversations; use at least 2 characters. Also searches recent chat titles (up to ${CHAT_LIMIT} per space), opened file names, files already listed in the current space and settings. Unloaded folders and file contents are not included.${current.limitedSpaces ? ` Chat titles and file names cover the first ${SPACE_LIMIT} spaces alphabetically; message search covers the selected scope.` : ""}`;
  return { records, loading: current.loading || messages.loading, error: [current.error, messages.error].filter(Boolean).join(" ") || null, notice, retry,
    hasMoreMessages: messages.hasMore, loadMoreMessages: messages.loadMore, loadingMoreMessages: messages.loadingMore, messagePageCount: messages.pageCount };
}
