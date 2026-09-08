import { type CSSProperties, useLayoutEffect, useMemo, useState } from "react";
import { ChatLines, DotsGrid3x3, Page, Plus } from "iconoir-react";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { Button } from "../../../components/Button";
import { SearchInput } from "../../../components/SearchInput";
import { listRowSurfaceToneClassName, LIST_ROW_SURFACE_BASE } from "../../../components/listRowStyles";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import type { StudioHistory } from "../../../navigation/useStudioHistory";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { useProject } from "../../../projects/useProject";
import { useProjects } from "../../../projects/useProjects";
import { useMergedControllerProjects } from "../../../projects/useMergedControllerProjects";

export type MobileNavigationSection = "chats" | "spaces";

export interface MobileNavigationSheetProps {
  section: MobileNavigationSection;
  onSectionChange: (section: MobileNavigationSection) => void;
  onClose: () => void;
  history: StudioHistory;
  keyboardOpen?: boolean;
  onNewChat: () => void;
  onOpenFiles: () => void;
  onOpenAllChats: () => void;
  onOpenAllSpaces: () => void;
}

// Shared compact controls have a coarse-pointer 44px minimum. The sheet's
// explicit 48px contract must win over those responsive defaults too.
const TARGET = "!min-h-12 !min-w-12";

function visibleBounds() {
  const viewport = window.visualViewport;
  const top = Math.max(0, Number.isFinite(viewport?.offsetTop) ? viewport!.offsetTop : 0);
  const height = typeof viewport?.height === "number" && Number.isFinite(viewport.height) && viewport.height > 0
    ? viewport.height : window.innerHeight;
  return { top, height };
}

/** Resize the sheet, not its full-screen backdrop. VisualViewport uses CSS
 * pixels already; its offset matters when Safari pans a focused search. */
function useSheetViewportStyle(): CSSProperties {
  const [bounds, setBounds] = useState(visibleBounds);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const update = () => { frame = null; setBounds(visibleBounds()); };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);
  return {
    position: "absolute",
    left: "var(--instafy-safe-area-inset-left, 0px)",
    right: "var(--instafy-safe-area-inset-right, 0px)",
    width: "auto",
    bottom: `max(0px, calc(100% - ${bounds.top + bounds.height}px))`,
    height: "auto",
    maxHeight: `min(40rem, max(0px, calc(${bounds.height}px - var(--instafy-safe-area-inset-top, 0px))))`,
  };
}

function Chats({ query, onClose, onOpenAll }: { query: string; onClose: () => void; onOpenAll: () => void }) {
  const { activeProjectId, activeProjectName, projectAccessPending, projectAccessBlocked } = useProject();
  const {
    projectKey, conversations, activeConversationId, remoteConversationHistoryResolved,
    remoteConversationHistoryError, retryRemoteConversationHistory,
  } = useConversations();
  const navigate = useStudioNavigation();
  const scopeReady = Boolean(activeProjectId && projectKey === activeProjectId && !projectAccessPending && !projectAccessBlocked);
  const rows = useMemo(() => scopeReady ? conversations
    .filter((chat) => chat.lifecycleStatus === "active" && (chat.title || "Untitled chat").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .slice().sort((a, b) => b.createdAt - a.createdAt) : [], [conversations, query, scopeReady]);
  return (
    <section aria-label="Loaded chats" className="space-y-2">
      <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Loaded chats in {activeProjectName}</p>
      {projectAccessBlocked ? <p role="status" className="px-2 text-sm">Chat access is unavailable for this space.</p> : null}
      {!scopeReady && !projectAccessBlocked ? <p role="status" className="px-2 text-sm">Loading this space’s chats…</p> : null}
      {scopeReady && remoteConversationHistoryError ? (
        <div role="status" className="rounded-xl bg-slate-50 p-2 dark:bg-[var(--color-studio-dark-panel-soft)]">
          <p className="text-sm">Couldn’t refresh chats. Loaded chats are still shown.</p>
          <Button className={TARGET} variant="ghost" onPress={retryRemoteConversationHistory}>Retry chats</Button>
        </div>
      ) : null}
      {scopeReady && !remoteConversationHistoryResolved && !remoteConversationHistoryError ? <p role="status" className="px-2 text-sm">Loading chats…</p> : null}
      <ul className="space-y-1">
        {rows.slice(0, 40).map((chat) => (
          <li key={chat.localId}>
            <Button
              variant="ghost" fullWidth
              className={`${TARGET} ${LIST_ROW_SURFACE_BASE} ${listRowSurfaceToneClassName(chat.localId === activeConversationId)} !justify-start px-3 text-left`}
              aria-current={chat.localId === activeConversationId ? "page" : undefined}
              onPress={() => {
                onClose();
                navigate({ kind: "conversation", projectId: activeProjectId, conversationId: chat.localId, conversationControllerId: chat.controllerId });
              }}
            >
              <ChatLines className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{chat.title || "Untitled chat"}</span>
            </Button>
          </li>
        ))}
      </ul>
      {rows.length > 40 ? <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Showing 40 of {rows.length} matching loaded chats. Refine your search or open All chats.</p> : null}
      {scopeReady && rows.length === 0 && remoteConversationHistoryResolved && !remoteConversationHistoryError ? (
        <p role="status" className="px-2 text-sm">{query.trim() ? "No matching loaded chats." : "No active chats loaded in this space."}</p>
      ) : null}
      <Button className={`${TARGET} w-full`} variant="outline" onPress={() => { onClose(); onOpenAll(); }}>All chats</Button>
    </section>
  );
}

/** Discovery mounts only after choosing Spaces; opening Chats adds no project read. */
function Spaces({ query, onClose, onOpenAll }: { query: string; onClose: () => void; onOpenAll: () => void }) {
  const { projectList, activeProjectId } = useProjects();
  const navigate = useStudioNavigation();
  const { mergedProjects, remoteLoading, remoteError, remoteRefreshing, retryRemoteProjects } = useMergedControllerProjects({
    localProjects: projectList, includeAllOrgs: true,
  });
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return mergedProjects.filter((project) => `${project.name} ${project.orgName}`.toLocaleLowerCase().includes(needle))
      .slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [mergedProjects, query]);
  return (
    <section aria-label="Accessible spaces" className="space-y-2">
      <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Spaces across your teams</p>
      {remoteError ? (
        <div role="status" className="rounded-xl bg-slate-50 p-2 dark:bg-[var(--color-studio-dark-panel-soft)]">
          <p className="text-sm">{remoteError}</p>
          <Button className={TARGET} variant="ghost" isDisabled={remoteRefreshing} onPress={retryRemoteProjects}>{remoteRefreshing ? "Retrying…" : "Retry spaces"}</Button>
        </div>
      ) : null}
      {remoteLoading ? <p role="status" className="px-2 text-sm">Loading spaces…</p> : null}
      <ul className="space-y-1">
        {rows.slice(0, 80).map((project) => (
          <li key={project.id}>
            <Button
              variant="ghost" fullWidth
              className={`${TARGET} ${LIST_ROW_SURFACE_BASE} ${listRowSurfaceToneClassName(project.id === activeProjectId)} !justify-start px-3 text-left`}
              aria-current={project.id === activeProjectId ? "page" : undefined}
              onPress={() => {
                onClose();
                if (project.id === activeProjectId) return;
                // Commit one destination; the access provider hydrates even a
                // newly discovered space and the previous chat stays in history.
                navigate({ kind: "conversation", projectId: project.id });
              }}
            >
              <DotsGrid3x3 className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="block truncate">{project.name}</span><span className="block truncate text-xs font-normal text-slate-500 dark:text-slate-400">{project.orgName}</span></span>
              {project.id === activeProjectId ? <span className="text-xs">Current</span> : null}
            </Button>
          </li>
        ))}
      </ul>
      {rows.length > 80 ? <p className="px-2 text-xs text-slate-500 dark:text-slate-400">Showing 80 of {rows.length} matching spaces. Refine your search or open All spaces.</p> : null}
      {!remoteLoading && !remoteError && rows.length === 0 ? <p role="status" className="px-2 text-sm">{query.trim() ? "No matching spaces." : "No spaces available."}</p> : null}
      <Button className={`${TARGET} w-full`} variant="outline" onPress={() => { onClose(); onOpenAll(); }}>All spaces</Button>
    </section>
  );
}

export function MobileNavigationSheet({ section, onSectionChange, onClose, history, keyboardOpen = false, onNewChat, onOpenFiles, onOpenAllChats, onOpenAllSpaces }: MobileNavigationSheetProps) {
  const [queries, setQueries] = useState({ chats: "", spaces: "" });
  const modalStyle = useSheetViewportStyle();
  useNativeBackButtonAction(true, onClose);
  const closeAndRun = (action: () => void) => { onClose(); action(); };
  return (
    <StudioDialogModal
      isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}
      dialogAriaLabel="Navigation" data-testid="mobile-navigation-sheet"
      className="!p-0" modalClassName="flex flex-col !max-w-none !rounded-b-none overflow-hidden"
      modalStyle={modalStyle} dialogClassName="flex min-h-0 flex-col [max-height:inherit]"
    >
      <div data-testid="mobile-navigation-results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {!queries[section].trim() ? <div className="mb-3 grid grid-cols-2 gap-2">
          <Button className={TARGET} variant="outline" onPress={() => closeAndRun(onNewChat)}><Plus className="h-5 w-5" aria-hidden="true" />New chat</Button>
          <Button className={TARGET} variant="outline" onPress={() => closeAndRun(onOpenFiles)}><Page className="h-5 w-5" aria-hidden="true" />Files</Button>
        </div> : null}
        {section === "chats" ? <Chats query={queries.chats} onClose={onClose} onOpenAll={onOpenAllChats} /> : <Spaces query={queries.spaces} onClose={onClose} onOpenAll={onOpenAllSpaces} />}
      </div>
      <div
        data-testid="mobile-navigation-footer"
        className="min-h-0 shrink-0 space-y-2 overflow-y-auto overscroll-contain border-t border-slate-200 p-3 [max-height:inherit] dark:border-[color:var(--color-studio-dark-panel-border)]"
        style={{ paddingBottom: keyboardOpen ? "0.5rem" : "max(0.75rem, var(--instafy-safe-area-inset-bottom, 0px))" }}
      >
        {/* Search and Close never move or remount as the keyboard opens. The
            secondary navigation yields space to actual matching rows. */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              id="mobile-navigation-search" label={section === "chats" ? "Search loaded chats" : "Search spaces"}
              placeholder={section === "chats" ? "Search loaded chats" : "Search spaces"}
              value={queries[section]} onChange={(event) => { const value = event.target.value; setQueries((current) => ({ ...current, [section]: value })); }}
              autoFocus={false} autoComplete="off" className={`${TARGET} !text-base`}
            />
          </div>
          <Button className={`${TARGET} w-18 shrink-0 !px-1`} variant="primary" onPress={onClose}>Close</Button>
        </div>
        {!keyboardOpen ? <div className="grid grid-cols-3 gap-2" data-testid="mobile-navigation-secondary">
          <div className="col-span-2 grid grid-cols-2 gap-2" role="group" aria-label="Navigation section">
            {(["chats", "spaces"] as const).map((next) => <Button key={next} className={`${TARGET} !px-1`} variant={section === next ? "secondary" : "ghost"} aria-pressed={section === next} onPress={() => onSectionChange(next)}>{next === "chats" ? "Chats" : "Spaces"}</Button>)}
          </div>
          <Button className={`${TARGET} !px-1`} variant="outline" isDisabled={!history.canGoForward} onPress={() => closeAndRun(history.goForward)}>Forward</Button>
        </div> : null}
      </div>
    </StudioDialogModal>
  );
}
