import { useEffect, useState, type Ref } from "react";
import { Bookmark, Trash } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import type { ControllerMessageStash } from "../../../services/runtimeController/messageStashes";
import {
  DARK_DIVIDER_BORDER_CLASS,
  DARK_PANEL_BORDER_CLASS,
  DARK_PANEL_STRONG_BG_CLASS,
} from "../../../theme/darkSurfaces";

export const CHAT_MESSAGE_STASH_PANEL_ID = "chat-message-stashes-panel";

export type ChatMessageStashTrayProps = {
  stashes: ControllerMessageStash[];
  restoredStashId: string | null;
  busy?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  onRestore: (stash: ControllerMessageStash) => void;
  onDelete: (stashId: string) => void;
};

function buildAccessibleDraftPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim() || "Untitled draft";
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}…`;
}

export function ChatMessageStashTrigger({
  count,
  expanded,
  onExpandedChange,
  triggerRef,
}: {
  count: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  if (count <= 0) {
    return null;
  }

  const countLabel = count > 99 ? "99+" : String(count);
  return (
    <IconButton
      type="button"
      aria-label={`Stashed drafts (${count})`}
      title={`Stashed drafts (${count})`}
      aria-controls={CHAT_MESSAGE_STASH_PANEL_ID}
      aria-expanded={expanded}
      ref={triggerRef}
      variant="outline"
      size="sm"
      radius="full"
      onPress={() => onExpandedChange(!expanded)}
      className="relative h-9 w-9 flex-none border-slate-200/70 bg-white/80 text-slate-600 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-300"
      data-testid="chat-message-stashes-summary"
    >
      <Bookmark aria-hidden="true" className="h-4 w-4" data-testid="chat-message-stashes-icon" />
      <span
        aria-hidden="true"
        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white dark:bg-slate-300 dark:text-slate-950 dark:ring-[color:var(--color-studio-dark-panel)]"
      >
        {countLabel}
      </span>
    </IconButton>
  );
}

export function ChatMessageStashPanel({
  stashes,
  restoredStashId,
  busy = false,
  onRestore,
  onDelete,
}: Pick<
  ChatMessageStashTrayProps,
  "stashes" | "restoredStashId" | "busy" | "onRestore" | "onDelete"
>) {
  if (stashes.length === 0) {
    return null;
  }

  return (
    <div
      id={CHAT_MESSAGE_STASH_PANEL_ID}
      role="region"
      aria-label="Stashed drafts"
      className="basis-full"
    >
      <Surface
        tone="default"
        radius="xl"
        shadow="none"
        className={`ml-auto w-full overflow-hidden border border-slate-200/70 bg-white/95 sm:w-[min(24rem,100%)] ${DARK_PANEL_STRONG_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`}
      >
        <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
          <Bookmark aria-hidden="true" className="h-4 w-4 flex-none text-slate-500 dark:text-slate-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            Stashed drafts
          </span>
          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{stashes.length}</span>
        </div>
        <div
          className={`max-h-[min(16rem,35dvh)] divide-y divide-slate-200/70 overflow-y-auto overscroll-contain border-t border-slate-200/70 dark:divide-slate-800/80 ${DARK_DIVIDER_BORDER_CLASS}`}
          data-testid="chat-message-stashes-list"
        >
          {stashes.map((stash, index) => {
            const preview = stash.text || "Untitled draft";
            const accessiblePreview = buildAccessibleDraftPreview(preview);
            return (
              <div key={stash.id} className="flex items-center gap-2.5 px-3 py-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  radius="md"
                  className="min-w-0 flex-1 justify-start bg-transparent px-0 py-0 text-left shadow-none hover:bg-transparent data-[hovered]:bg-transparent"
                  aria-label={`Restore stashed draft ${index + 1}: ${accessiblePreview}`}
                  isDisabled={busy}
                  onPress={() => onRestore(stash)}
                  data-testid="chat-message-stash-restore"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-800 dark:text-slate-100">
                      {preview}
                    </span>
                    {restoredStashId === stash.id ? (
                      <span className="block text-xxs font-semibold uppercase tracking-[0.14em] text-primary-600 dark:text-primary-300">
                        Restored in composer
                      </span>
                    ) : null}
                  </span>
                </Button>
                <IconButton
                  type="button"
                  aria-label={`Delete stashed draft ${index + 1}: ${accessiblePreview}`}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  isDisabled={busy}
                  onPress={() => onDelete(stash.id)}
                  data-testid="chat-message-stash-delete"
                >
                  <Trash aria-hidden="true" className="h-4 w-4" />
                </IconButton>
              </div>
            );
          })}
        </div>
      </Surface>
    </div>
  );
}

export function ChatMessageStashTray({
  stashes,
  restoredStashId,
  busy = false,
  expanded,
  onExpandedChange,
  triggerRef,
  onRestore,
  onDelete,
}: ChatMessageStashTrayProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const isExpanded = expanded ?? uncontrolledExpanded;
  const setExpanded = (nextExpanded: boolean) => {
    if (expanded === undefined) {
      setUncontrolledExpanded(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  };

  useEffect(() => {
    if (stashes.length === 0) {
      setUncontrolledExpanded(false);
    }
  }, [stashes.length]);

  if (stashes.length === 0) {
    return null;
  }

  return (
    <div className="contents" data-testid="chat-message-stashes">
      <ChatMessageStashTrigger
        count={stashes.length}
        expanded={isExpanded}
        onExpandedChange={setExpanded}
        triggerRef={triggerRef}
      />
      {isExpanded ? (
        <ChatMessageStashPanel
          stashes={stashes}
          restoredStashId={restoredStashId}
          busy={busy}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      ) : (
        <span id={CHAT_MESSAGE_STASH_PANEL_ID} hidden />
      )}
    </div>
  );
}
