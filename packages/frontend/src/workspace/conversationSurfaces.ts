import { useCallback, useMemo, useRef, useState } from "react";

export type ConversationFileView = {
  id: string;
  path: string;
  line?: number;
  markdownView?: "edit" | "preview";
};
export type ConversationSurfaces = {
  activeId: string;
  resourceId: string;
  split: boolean;
  ratio: number;
  files: ConversationFileView[];
};
export const DEFAULT_CONVERSATION_SURFACES: ConversationSurfaces = {
  activeId: "chat", resourceId: "browser", split: true, ratio: 0.55, files: [],
};
const storageKey = (scope: string) => `instafy:conversation-views:${scope}`;

export function readConversationSurfaces(scope: string): ConversationSurfaces {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(scope)) ?? "null");
    if (!value || !Array.isArray(value.files)) return DEFAULT_CONVERSATION_SURFACES;
    const files: ConversationFileView[] = value.files.filter((file: ConversationFileView) =>
      file && typeof file.path === "string" && file.path.length > 0 && file.id === `file:${file.path}`,
    ).slice(0, 30).map((file: ConversationFileView) => ({
      id: file.id, path: file.path,
      ...(typeof file.line === "number" && Number.isFinite(file.line) ? { line: Math.max(1, Math.floor(file.line)) } : {}),
      ...(file.markdownView === "preview" || file.markdownView === "edit" ? { markdownView: file.markdownView } : {}),
    }));
    const valid = (id: string) => id === "browser" || files.some(file => file.id === id);
    return {
      activeId: value.activeId === "chat" || valid(value.activeId) ? value.activeId : "chat",
      resourceId: valid(value.resourceId) ? value.resourceId : "browser",
      split: value.split !== false,
      ratio: typeof value.ratio === "number" && Number.isFinite(value.ratio) ? Math.min(0.7, Math.max(0.35, value.ratio)) : 0.55,
      files,
    };
  } catch { return DEFAULT_CONVERSATION_SURFACES; }
}

/** Owned by WorkspaceTabsProvider. Only view references/preferences are persisted. */
export function useConversationSurfacesOwner() {
  const states = useRef(new Map<string, ConversationSurfaces>());
  const [revision, setRevision] = useState(0);
  const read = useCallback((scope: string | null) => {
    if (!scope) return DEFAULT_CONVERSATION_SURFACES;
    let state = states.current.get(scope);
    if (!state) {
      state = readConversationSurfaces(scope);
      states.current.set(scope, state);
    }
    return state;
  }, []);
  const update = useCallback((scope: string | null, change: (state: ConversationSurfaces) => ConversationSurfaces) => {
    if (!scope) return;
    const next = change(read(scope));
    states.current.set(scope, next);
    try { sessionStorage.setItem(storageKey(scope), JSON.stringify(next)); } catch { /* session-only fallback */ }
    setRevision(value => value + 1);
  }, [read]);
  return useMemo(() => ({ read, update, revision }), [read, update, revision]);
}

export function selectConversationView(state: ConversationSurfaces, id: string): ConversationSurfaces {
  return { ...state, activeId: id, resourceId: id === "chat" ? state.resourceId : id };
}

export function openConversationFile(state: ConversationSurfaces, file: ConversationFileView): ConversationSurfaces {
  return {
    ...selectConversationView(state, file.id),
    files: [...state.files.filter(item => item.id !== file.id), file].slice(-30),
  };
}
