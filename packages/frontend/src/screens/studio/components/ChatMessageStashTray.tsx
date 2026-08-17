import { useEffect, useState } from "react";
import { NavArrowDown, Trash } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import type { ControllerMessageStash } from "../../../services/runtimeController/messageStashes";
import {
  DARK_DIVIDER_BORDER_CLASS,
  DARK_PANEL_BORDER_CLASS,
  DARK_PANEL_SHADOW_CLASS,
  DARK_PANEL_STRONG_BG_CLASS,
} from "../../../theme/darkSurfaces";

export function ChatMessageStashTray({
  stashes,
  restoredStashId,
  busy = false,
  onRestore,
  onDelete,
}: {
  stashes: ControllerMessageStash[];
  restoredStashId: string | null;
  busy?: boolean;
  onRestore: (stash: ControllerMessageStash) => void;
  onDelete: (stashId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (stashes.length === 0) {
      setExpanded(false);
    }
  }, [stashes.length]);

  if (stashes.length === 0) {
    return null;
  }

  const latest = stashes[0];
  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="none"
      className={`overflow-hidden border border-slate-200/70 bg-white/95 ${DARK_PANEL_STRONG_BG_CLASS} ${DARK_PANEL_BORDER_CLASS} ${DARK_PANEL_SHADOW_CLASS}`}
      data-testid="chat-message-stashes"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          data-testid="chat-message-stashes-summary"
        >
          <span className="block text-xxs font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
            Drafts ({stashes.length})
          </span>
          <span className="block truncate text-sm text-slate-800 dark:text-slate-100">
            {latest.text || "Untitled draft"}
          </span>
        </button>
        {!expanded ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            radius="full"
            isDisabled={busy}
            onPress={() => onRestore(latest)}
            data-testid="chat-message-stash-restore-latest"
          >
            Restore
          </Button>
        ) : null}
        <IconButton
          type="button"
          aria-label={expanded ? "Collapse stashed drafts" : "Expand stashed drafts"}
          variant="ghost"
          size="xs"
          radius="full"
          onPress={() => setExpanded((current) => !current)}
          data-testid="chat-message-stashes-toggle"
        >
          <NavArrowDown
            aria-hidden="true"
            className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </IconButton>
      </div>
      {expanded ? (
        <div
          className={`divide-y divide-slate-200/70 border-t border-slate-200/70 dark:divide-slate-800/80 ${DARK_DIVIDER_BORDER_CLASS}`}
          data-testid="chat-message-stashes-list"
        >
          {stashes.map((stash) => (
            <div key={stash.id} className="flex items-center gap-2.5 px-3 py-2.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                radius="md"
                className="min-w-0 flex-1 justify-start bg-transparent px-0 py-0 text-left shadow-none hover:bg-transparent data-[hovered]:bg-transparent"
                isDisabled={busy}
                onPress={() => onRestore(stash)}
                data-testid="chat-message-stash-restore"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-800 dark:text-slate-100">
                    {stash.text || "Untitled draft"}
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
                aria-label="Delete stashed draft"
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
          ))}
        </div>
      ) : null}
    </Surface>
  );
}
