import { Xmark } from "iconoir-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { formatPromptContextModeLabel, formatTokenCountLabel, resolveTokenUsageForMessage } from "./chatMessageDetailHelpers";
import { ImageMarkupEditor } from "./ImageMarkupEditor";

type MessageMenuLike = {
  kind: "message" | "conversation";
  messageId: string | null;
  x: number;
  y: number;
  maxHeight: number;
  view: "actions" | "token_usage";
};

type ImageLightboxLike = {
  src: string;
  alt: string;
};

type InvitePromptLike = {
  missingUsers: Array<{
    displayName?: string | null;
    handle?: string | null;
  }>;
};

type SelectedMessageTokenUsage = ReturnType<typeof resolveTokenUsageForMessage>;

export function ChatMessageMenuOverlay({
  messageMenu,
  selectedMessageTokenUsage,
  onClose,
  onShowActionsView,
  onShowTokenUsageView,
  onCopySelectedMessage,
  onCopyConversation,
  onCopyTokenUsage,
  selectedTextAvailable = false,
  onReplyToSelection,
  onSummarizeSelection,
  onExplainSelection,
  onOpenThread,
  openThreadLabel,
}: {
  messageMenu: MessageMenuLike | null;
  selectedMessageTokenUsage: SelectedMessageTokenUsage;
  onClose: () => void;
  onShowActionsView: () => void;
  onShowTokenUsageView: () => void;
  onCopySelectedMessage: () => void;
  onCopyConversation: () => void;
  onCopyTokenUsage: () => void;
  selectedTextAvailable?: boolean;
  onReplyToSelection?: () => void;
  onSummarizeSelection?: () => void;
  onExplainSelection?: () => void;
  // When the selected message is an agent run, opens its run thread in a workspace tab.
  onOpenThread?: (() => void) | null;
  openThreadLabel?: string;
}) {
  if (!messageMenu) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50"
      onPointerDown={onClose}
      onContextMenu={(event) => event.preventDefault()}
      aria-hidden="true"
    >
      <Surface
        tone="default"
        radius="xl"
        shadow="lg"
        className="w-64 overflow-y-auto p-2 text-sm"
        style={{
          position: "fixed",
          left: messageMenu.x,
          top: messageMenu.y,
          maxHeight: messageMenu.maxHeight,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {messageMenu.view === "token_usage" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Text as="span" variant="overline" tone="subtle" className="tracking-wide">
                Message stats
              </Text>
              <Button
                variant="ghost"
                size="xs"
                radius="full"
                onPress={onShowActionsView}
              >
                Back
              </Button>
            </div>
            {selectedMessageTokenUsage ? (
              <>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge size="xs" className="text-slate-600">
                    Input {selectedMessageTokenUsage.inputTokens}
                  </Badge>
                  <Badge size="xs" className="text-slate-600">
                    Cached {selectedMessageTokenUsage.cachedInputTokens}
                  </Badge>
                  <Badge size="xs" className="text-slate-600">
                    Output {selectedMessageTokenUsage.outputTokens}
                  </Badge>
                  {selectedMessageTokenUsage.context ? (
                    <Badge size="xs" className="text-slate-600">
                      {formatPromptContextModeLabel(selectedMessageTokenUsage.context)}
                    </Badge>
                  ) : null}
                </div>
                {selectedMessageTokenUsage.context ? (
                  <div className="space-y-2 text-xs text-slate-500">
                    <div className="flex flex-wrap gap-2">
                      {selectedMessageTokenUsage.context.estimatedPromptTokens !== null ? (
                        <Badge size="xs" className="text-slate-600">
                          Prompt {formatTokenCountLabel(selectedMessageTokenUsage.context.estimatedPromptTokens)}
                        </Badge>
                      ) : null}
                      {selectedMessageTokenUsage.context.estimatedHistoryTokens !== null ? (
                        <Badge size="xs" className="text-slate-600">
                          History {formatTokenCountLabel(selectedMessageTokenUsage.context.estimatedHistoryTokens)}
                        </Badge>
                      ) : null}
                      {selectedMessageTokenUsage.context.modelContextWindow !== null ? (
                        <Badge size="xs" className="text-slate-600">
                          Window {formatTokenCountLabel(selectedMessageTokenUsage.context.modelContextWindow)}
                        </Badge>
                      ) : null}
                      {selectedMessageTokenUsage.context.estimatedPromptUsagePercent !== null ? (
                        <Badge size="xs" className="text-slate-600">
                          {selectedMessageTokenUsage.context.estimatedPromptUsagePercent}% used
                        </Badge>
                      ) : null}
                    </div>
                    {(selectedMessageTokenUsage.context.totalTurns !== null ||
                      selectedMessageTokenUsage.context.includedTurns !== null ||
                      selectedMessageTokenUsage.context.summarizedTurns !== null ||
                      selectedMessageTokenUsage.context.omittedTurns !== null) ? (
                      <div className="rounded-2xl border border-slate-200/70 px-3 py-2">
                        <Text as="div" variant="caption" tone="muted">
                          {selectedMessageTokenUsage.context.totalTurns !== null
                            ? `Turns ${selectedMessageTokenUsage.context.includedTurns ?? 0}/${selectedMessageTokenUsage.context.totalTurns}`
                            : "Prompt context details"}
                        </Text>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {selectedMessageTokenUsage.context.summarizedTurns !== null &&
                          selectedMessageTokenUsage.context.summarizedTurns > 0 ? (
                            <Badge size="xs" className="text-slate-600">
                              Summarized {selectedMessageTokenUsage.context.summarizedTurns}
                            </Badge>
                          ) : null}
                          {selectedMessageTokenUsage.context.omittedTurns !== null &&
                          selectedMessageTokenUsage.context.omittedTurns > 0 ? (
                            <Badge size="xs" className="text-slate-600">
                              Omitted {selectedMessageTokenUsage.context.omittedTurns}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <Button
                  variant="outline"
                  size="xs"
                  radius="full"
                  fullWidth
                  onPress={() => void onCopyTokenUsage()}
                >
                  Copy stats
                </Button>
              </>
            ) : (
              <Text as="p" variant="caption" tone="muted">
                No message stats are available.
              </Text>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {messageMenu.kind === "message" && selectedTextAvailable ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  onPress={() => void onReplyToSelection?.()}
                  className="justify-start"
                >
                  Reply to selection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  onPress={() => void onSummarizeSelection?.()}
                  className="justify-start"
                >
                  Summarize selection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  onPress={() => void onExplainSelection?.()}
                  className="justify-start"
                >
                  Explain more
                </Button>
                <div className="my-1 h-px bg-slate-200/80 dark:bg-[color:var(--color-studio-dark-divider)]" />
              </>
            ) : null}
            {messageMenu.kind === "message" && onOpenThread ? (
              <Button
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                onPress={() => {
                  onOpenThread();
                  onClose();
                }}
                className="justify-start"
              >
                {openThreadLabel ?? "Open thread"}
              </Button>
            ) : null}
            {messageMenu.kind === "message" ? (
              <Button
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                onPress={() => void onCopySelectedMessage()}
                className="justify-start"
              >
                Copy message
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              radius="lg"
              fullWidth
              onPress={() => void onCopyConversation()}
              className="justify-start"
            >
              Copy conversation
            </Button>
            {messageMenu.kind === "message" && selectedMessageTokenUsage ? (
              <Button
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                onPress={onShowTokenUsageView}
                className="justify-start"
              >
                Message stats…
              </Button>
            ) : null}
          </div>
        )}
      </Surface>
    </div>
  );
}

export function ChatImageLightboxOverlay({
  imageLightbox,
  onClose,
  onSaveMarkup,
  onRestoreOriginal,
  editDisabled = false,
}: {
  imageLightbox: ImageLightboxLike | null;
  onClose: () => void;
  onSaveMarkup?: (blob: Blob) => void | Promise<void>;
  onRestoreOriginal?: () => void;
  editDisabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const markupButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasEditingRef = useRef(false);
  useEffect(() => {
    setEditing(false);
  }, [imageLightbox?.src]);
  useEffect(() => {
    if (!editing && wasEditingRef.current) markupButtonRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);
  const dismiss = () => {
    if (saving) return;
    if (editing) setEditing(false);
    else onClose();
  };
  useNativeBackButtonAction(Boolean(imageLightbox), dismiss);
  if (!imageLightbox) {
    return null;
  }

  const closeButton = (
    <IconButton
      type="button"
      variant="secondary"
      size="sm"
      radius="full"
      autoFocus
      onPress={dismiss}
      aria-label="Close image preview"
      data-testid="chat-image-lightbox-close"
      className={onSaveMarkup ? "min-h-11 min-w-11 shrink-0" : "absolute right-2 top-2 z-10"}
    >
      <Xmark className="h-4 w-4" aria-hidden="true" />
    </IconButton>
  );

  return (
    <ModalOverlay
      isOpen
      isDismissable={!saving}
      isKeyboardDismissDisabled={saving}
      onOpenChange={(open) => { if (!open) dismiss(); }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 p-4"
      data-testid="chat-image-lightbox"
      style={{
        paddingBottom: "max(var(--instafy-safe-area-inset-bottom), 1rem)",
        paddingLeft: "max(var(--instafy-safe-area-inset-left), 1rem)",
        paddingRight: "max(var(--instafy-safe-area-inset-right), 1rem)",
        paddingTop: "max(var(--instafy-safe-area-inset-top), 1rem)",
      }}
    >
      <Modal className={`relative max-h-full max-w-full outline-none ${editing ? "flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-slate-950 text-white" : onSaveMarkup ? "flex flex-col" : ""}`}>
        <Dialog aria-label={editing ? "Mark up image" : "Image preview"} className={`min-h-0 outline-none ${editing ? "flex flex-col p-3" : onSaveMarkup ? "flex flex-col" : ""}`}>
          {editing && onSaveMarkup ? (
            <ImageMarkupEditor
              key={imageLightbox.src}
              src={imageLightbox.src}
              alt={imageLightbox.alt}
              onCancel={() => setEditing(false)}
              onSavingChange={setSaving}
              onSave={async (blob) => {
                if (editDisabled) throw new Error("Wait for the image upload to finish before editing.");
                await onSaveMarkup(blob);
                setEditing(false);
              }}
            />
          ) : <>
          {onSaveMarkup ? (
            <div className="mb-2 flex shrink-0 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Button
                  ref={markupButtonRef}
                  variant="secondary"
                  size="sm"
                  onPress={() => setEditing(true)}
                  isDisabled={editDisabled}
                  className="min-h-11 min-w-11"
                  data-testid="chat-image-markup-open"
                >
                  Mark up
                </Button>
                {onRestoreOriginal ? (
                  <Button variant="secondary" size="sm" onPress={onRestoreOriginal} isDisabled={editDisabled} className="min-h-11 min-w-11" data-testid="chat-image-restore-original">
                    Restore original
                  </Button>
                ) : null}
              </div>
              {closeButton}
            </div>
          ) : null}
          {onSaveMarkup ? null : closeButton}
          <img
            src={imageLightbox.src}
            alt={imageLightbox.alt}
            className={`rounded-2xl border border-slate-200 bg-white shadow-lg dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)] ${onSaveMarkup ? "min-h-0 max-h-[80dvh] max-w-full self-center object-contain" : "max-h-[80vh] max-w-[90vw]"}`}
            data-testid="chat-image-lightbox-image"
          />
          </>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function ChatInvitePromptOverlay({
  invitePrompt,
  invitePromptBusy,
  onClose,
  onSendWithout,
  onInviteAndSend,
}: {
  invitePrompt: InvitePromptLike | null;
  invitePromptBusy: boolean;
  onClose: () => void;
  onSendWithout: () => void;
  onInviteAndSend: () => void;
}) {
  if (!invitePrompt) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Invite teammate"
      data-testid="chat-invite-prompt"
      onClick={onClose}
      style={{
        paddingBottom: "max(var(--instafy-safe-area-inset-bottom), 1rem)",
        paddingLeft: "max(var(--instafy-safe-area-inset-left), 1rem)",
        paddingRight: "max(var(--instafy-safe-area-inset-right), 1rem)",
        paddingTop: "max(var(--instafy-safe-area-inset-top), 1rem)",
      }}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="space-y-1 px-4 pb-2 pt-4">
          <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm">
            Add to this private chat?
          </Text>
          <Text as="div" variant="caption" tone="muted" className="text-xs leading-snug">
            {invitePrompt.missingUsers.length === 1 ? (
              <>
                <span className="font-medium">{invitePrompt.missingUsers[0]?.displayName ?? "Teammate"}</span>{" "}
                can’t see this conversation yet.
              </>
            ) : (
              <>
                These teammates can’t see this conversation yet:{" "}
                <span className="font-medium">
                  {invitePrompt.missingUsers
                    .map((user) => user.displayName || user.handle || "Teammate")
                    .join(", ")}
                </span>
                .
              </>
            )}
          </Text>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-3 py-3 dark:border-[color:var(--color-studio-dark-divider)]">
          <Button
            variant="ghost"
            size="sm"
            radius="xl"
            isDisabled={invitePromptBusy}
            onPress={() => void onSendWithout()}
          >
            Send without @
          </Button>
          <Button
            variant="primary"
            size="sm"
            radius="xl"
            isDisabled={invitePromptBusy}
            onPress={() => void onInviteAndSend()}
          >
            {invitePromptBusy ? (
              <>
                <Spinner aria-hidden="true" tone="primary" size="xs" />
                Inviting…
              </>
            ) : (
              "Invite & send"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
