import { useEffect, useRef, useState, type Ref } from "react";
import { Bookmark, Trash } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { ToolbarCountButton } from "../../../components/ToolbarCountButton";
import type { ControllerMessageStash } from "../../../services/runtimeController/messageStashes";
import { ComposerMessagePanel } from "./ComposerMessagePanel";

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

  return (
    <ToolbarCountButton
      count={count}
      aria-label={`Stashed drafts (${count})`}
      title={`Stashed drafts (${count})`}
      aria-controls={CHAT_MESSAGE_STASH_PANEL_ID}
      expanded={expanded}
      ref={triggerRef}
      onPress={() => onExpandedChange(!expanded)}
      data-testid="chat-message-stashes-summary"
    >
      <Bookmark aria-hidden="true" className="h-4 w-4" data-testid="chat-message-stashes-icon" />
    </ToolbarCountButton>
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
  const restoreButtons = useRef(new Map<string, HTMLButtonElement>());
  if (stashes.length === 0) {
    return null;
  }

  return (
    <ComposerMessagePanel
      id={CHAT_MESSAGE_STASH_PANEL_ID}
      title="Stashed drafts"
      icon={<Bookmark />}
      presentation="list"
      headerTestId="chat-message-stashes-panel-header"
      listTestId="chat-message-stashes-list"
    >
      {stashes.map((stash, index) => {
        const preview = stash.text || "Untitled draft";
        const accessiblePreview = buildAccessibleDraftPreview(preview);
        return (
          <div key={stash.id} className="flex items-center gap-2 p-1.5">
            <Button
              ref={button => {
                if (button) restoreButtons.current.set(stash.id, button);
                else restoreButtons.current.delete(stash.id);
              }}
              type="button"
              variant="ghost"
              preset="inline"
              className="min-w-0 flex-1 justify-start text-left"
              aria-label={`Restore stashed draft ${index + 1}: ${accessiblePreview}`}
              isDisabled={busy}
              onPress={() => onRestore(stash)}
              data-testid="chat-message-stash-restore"
            >
              <span className="min-w-0">
                <Text as="span" variant="bodyStrong" tone="inherit" className="block truncate">
                  {preview}
                </Text>
                {restoredStashId === stash.id ? (
                  <Text as="span" variant="caption" tone="accent" className="block">
                    Restored in composer
                  </Text>
                ) : null}
              </span>
            </Button>
            <IconButton
              type="button"
              aria-label={`Delete stashed draft ${index + 1}: ${accessiblePreview}`}
              variant="ghost"
              tone="danger"
              isDisabled={busy}
              onPress={() => {
                // Keep focus in the panel when the focused delete control
                // disappears. The owner handles the final draft's removal.
                const next = stashes[index + 1] ?? stashes[index - 1];
                if (next) restoreButtons.current.get(next.id)?.focus();
                onDelete(stash.id);
              }}
              data-testid="chat-message-stash-delete"
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          </div>
        );
      })}
    </ComposerMessagePanel>
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
