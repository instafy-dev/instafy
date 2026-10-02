import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationState } from "../conversations/conversationState";
import type { ProjectListItem } from "../projects/useProjects";
import type { WorkspaceTabState } from "./workspaceTabFactories";

export type OrganizationChatReference = {
  id: string;
  projectId: string;
  orgKey: string;
  conversationId: string;
  controllerId?: string;
  title: string;
  preview: boolean;
  viewTabId?: string;
  badge?: string | null;
};
export type OrganizationChatTab = OrganizationChatReference & { spaceName: string };
type State = Record<string, OrganizationChatReference[]>;
const key = (userId: string) => `instafy:organization-chat-tabs:v1:${userId}`;
export const organizationChatId = (projectId: string, conversationId: string) => JSON.stringify([projectId, conversationId]);

function read(userId: string | null): State {
  if (!userId) return {};
  try {
    const input: unknown = JSON.parse(sessionStorage.getItem(key(userId)) ?? "null");
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const result: State = {};
    for (const [projectId, values] of Object.entries(input)) {
      if (!Array.isArray(values)) continue;
      const seen = new Set<string>();
      result[projectId] = values.slice(0, 100).flatMap(value => {
        if (!value || typeof value !== "object" || value.projectId !== projectId ||
          typeof value.conversationId !== "string" || !value.conversationId ||
          typeof value.orgKey !== "string" || typeof value.title !== "string" || seen.has(value.conversationId)) return [];
        seen.add(value.conversationId);
        return [{ id: organizationChatId(projectId, value.conversationId), projectId, orgKey: value.orgKey,
          conversationId: value.conversationId, title: value.title.slice(0, 500), preview: value.preview === true,
          ...(typeof value.controllerId === "string" ? { controllerId: value.controllerId } : {}),
          ...(typeof value.viewTabId === "string" ? { viewTabId: value.viewTabId } : {}),
        }];
      });
    }
    return result;
  } catch { return {}; }
}

/** Navigation references only. Chat content, drafts and resource views retain their existing owners. */
export function useOrganizationChatTabs({ userId, orgKey, projects, projectId, ready, tabs, conversations, activeTab }: {
  userId: string | null;
  orgKey: string;
  projects: readonly Pick<ProjectListItem, "id" | "name" | "orgId">[];
  projectId: string | null;
  ready: boolean;
  tabs: readonly WorkspaceTabState[];
  conversations: readonly ConversationState[];
  activeTab: WorkspaceTabState | null;
}) {
  const [snapshot, setSnapshot] = useState(() => ({ userId, state: read(userId) }));
  // Account changes must never paint the preceding user's labels, even for one render.
  const state = useMemo(() => snapshot.userId === userId ? snapshot.state : read(userId), [snapshot, userId]);
  const project = projects.find(item => item.id === projectId);
  const nextProject = useMemo(() => {
    if (!userId || !ready || !project || !projectId) return null;
    const known = new Map(conversations.filter(chat => chat.lifecycleStatus !== "deleted").map(chat => [chat.localId, chat]));
    const previous = new Map((state[projectId] ?? []).map(tab => [tab.conversationId, tab]));
    return tabs.flatMap(tab => {
      if (tab.kind !== "conversation") return [];
      const chat = known.get(tab.conversationId);
      if (!chat) return [];
      const owned = activeTab?.workspaceOwner;
      const isActive = owned?.userId === userId && owned.projectId === projectId && owned.conversationId === chat.localId;
      const viewTabId = isActive ? activeTab?.id
        : activeTab?.kind === "conversation" && activeTab.conversationId === chat.localId ? undefined : previous.get(chat.localId)?.viewTabId;
      return [{ id: organizationChatId(projectId, chat.localId), projectId, orgKey: project.orgId ?? "personal",
        conversationId: chat.localId, controllerId: chat.controllerId ?? undefined, title: chat.title,
        preview: tab.preview === true, viewTabId, badge: tab.badge }];
    });
  }, [activeTab, conversations, project, projectId, ready, state, tabs, userId]);
  const currentState = useMemo(() => nextProject && projectId ? { ...state, [projectId]: nextProject } : state, [nextProject, projectId, state]);
  useEffect(() => {
    if (snapshot.userId === userId && JSON.stringify(snapshot.state) === JSON.stringify(currentState)) return;
    setSnapshot({ userId, state: currentState });
  }, [currentState, snapshot, userId]);
  useEffect(() => {
    if (!userId) return;
    try { sessionStorage.setItem(key(userId), JSON.stringify(currentState)); } catch { /* session memory still works */ }
  }, [currentState, userId]);

  const visible = useMemo(() => {
    const available = new Map(projects.filter(item => (item.orgId ?? "personal") === orgKey).map(item => [item.id, item]));
    return Object.entries(currentState).flatMap(([id, entries]) => {
      const space = available.get(id);
      return space ? entries.filter(tab => tab.orgKey === orgKey).map(tab => ({ ...tab, badge: id === projectId ? tab.badge : null, spaceName: space.name })) : [];
    });
  }, [currentState, orgKey, projectId, projects]);
  const updateInactive = useCallback((tab: OrganizationChatTab, action: "close" | "keep") => {
    // Only background references visible in this scope can be edited here.
    if (tab.projectId === projectId || !visible.some(item => item.id === tab.id)) return;
    setSnapshot(previous => {
      if (previous.userId !== userId) return previous;
      const items = previous.state[tab.projectId] ?? [];
      return { userId, state: { ...previous.state, [tab.projectId]: action === "close"
        ? items.filter(item => item.id !== tab.id)
        : items.map(item => item.id === tab.id ? { ...item, preview: false } : item) } };
    });
  }, [projectId, userId, visible]);
  return { tabs: visible, updateInactive };
}
