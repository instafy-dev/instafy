import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Bookmark,
  Expand,
  Github,
  Group,
  MagicWand,
  MediaImage,
  Microphone,
  NavArrowLeft,
  NavArrowRight,
  OpenNewWindow,
  PlugTypeC,
  Plus,
  Safari,
  Search,
  Send,
  SoundHigh,
  SoundOff,
  Terminal,
} from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { Badge } from "../../../components/Badge";
import { IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { StudioMenuAction, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { CHAT_SLASH_COMMANDS } from "../../../conversations/slashCommands";
import { AVAILABLE_FEATURED_CONNECTORS, type ProductConnector } from "./connectors";

type ComposerActionMenuView = "main" | "commands" | "connect";

const NO_INSTALLED_SKILLS: ReadonlySet<string> = new Set();

// The popover is a Dialog of ghost Buttons, so Tab already reaches every row;
// this adds menu-style ArrowUp/ArrowDown (wrapping) and Home/End between the
// enabled rows of whichever view is showing.
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>) {
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") {
    return;
  }
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
  );
  if (rows.length === 0) {
    return;
  }
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (key === "Home") {
    next = 0;
  } else if (key === "End") {
    next = rows.length - 1;
  } else if (key === "ArrowDown") {
    next = index < 0 ? 0 : (index + 1) % rows.length;
  } else {
    next = index <= 0 ? rows.length - 1 : index - 1;
  }
  rows[next]?.focus();
  event.preventDefault();
}

function commandTestId(command: string): string {
  const normalized = command.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return `composer-action-menu-command-${normalized || "root"}`;
}

function ActionRow({
  icon,
  title,
  description,
  onPress,
  end,
  testId,
  disabled = false,
  hoverTitle,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  onPress: () => void;
  end?: ReactNode;
  testId?: string;
  disabled?: boolean;
  /**
   * Keep the native tooltip on a wrapper so the reason remains reachable
   * even when the action itself is disabled.
   */
  hoverTitle?: string;
}) {
  const row = (
    <StudioMenuAction
      type="button"
      onPress={onPress}
      isDisabled={disabled}
      data-testid={testId}
    >
      <MenuItemContent start={icon} end={end} description={description}>
        {title}
      </MenuItemContent>
    </StudioMenuAction>
  );
  return hoverTitle ? <div title={hoverTitle}>{row}</div> : row;
}

export function ComposerActionMenu({
  disabled = false,
  showBrowserAction = true,
  showNewBrowserAction = true,
  showInviteAction = true,
  pendingNewBrowser,
  onOpenBrowser,
  onOpenNewBrowser,
  onOpenInvite,
  onImportGithubRepo,
  onSelectConnector,
  onBrowseConnectors,
  installedSkillNames = NO_INSTALLED_SKILLS,
  onInsertCommand,
  onQueueMessage,
  onStashDraft,
  onExpandDraft,
  queueDisabled = false,
  stashDisabled = false,
  onUploadImage,
  uploadImageDisabled = false,
  uploadImageUnavailableReason = null,
  onInsertSuggestion,
  onStartVoiceInput,
  voiceInputDisabled = false,
  onToggleVoiceReplies,
  voiceRepliesEnabled = false,
  voiceRepliesDisabled = false,
  triggerClassName,
  triggerIconClassName,
  mutationDisabled = false,
  inviteActionLabel = "Invite teammates",
}: {
  disabled?: boolean;
  showBrowserAction?: boolean;
  showNewBrowserAction?: boolean;
  showInviteAction?: boolean;
  pendingNewBrowser: boolean;
  onOpenBrowser: () => void;
  onOpenNewBrowser: () => void;
  onOpenInvite: () => void;
  onImportGithubRepo: () => void;
  // "Connect a tool" opens a sub-view of the featured connector rows that can
  // be selected today plus "Browse all tools"; a row press closes the menu and
  // reports the connector, the last row closes the menu and opens the Connect
  // sheet's browse stage. A "soon" connector (pack not published yet) is not
  // listed here: the sheet names it with its Badge. Nothing here sends or
  // prefills.
  onSelectConnector?: (connector: ProductConnector) => void;
  onBrowseConnectors?: () => void;
  installedSkillNames?: ReadonlySet<string>;
  onInsertCommand: (command: string) => void;
  onQueueMessage?: () => void;
  onStashDraft?: () => void;
  onExpandDraft?: () => void;
  queueDisabled?: boolean;
  stashDisabled?: boolean;
  // Image upload and insert suggestion live in this menu on every viewport
  // (Tab also accepts the inline ghost suggestion from the keyboard). The
  // composer passes each handler only while it applies.
  onUploadImage?: () => void;
  uploadImageDisabled?: boolean;
  /** Shown under "Upload image", which is then off, when this server can't store attachments. */
  uploadImageUnavailableReason?: string | null;
  onInsertSuggestion?: () => void;
  onStartVoiceInput?: () => void;
  voiceInputDisabled?: boolean;
  onToggleVoiceReplies?: () => void;
  voiceRepliesEnabled?: boolean;
  voiceRepliesDisabled?: boolean;
  triggerClassName?: string;
  // The trigger's glyph uses the same size as the composer's other controls.
  triggerIconClassName: string;
  mutationDisabled?: boolean;
  inviteActionLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ComposerActionMenuView>("main");

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setView("main");
    }
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setView("main");
  }, []);
  useNativeBackButtonAction(open, () => {
    if (view !== "main") setView("main");
    else closeMenu();
  });

  const visibleCommands = useMemo(
    () => CHAT_SLASH_COMMANDS.filter((command) => !command.hidden),
    [],
  );
  const commandKeyLabel = useMemo(() => {
    if (typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)) {
      return "⌘";
    }
    return "Ctrl";
  }, []);

  return (
    <DialogTrigger isOpen={open} onOpenChange={handleOpenChange}>
      <IconButton
        type="button"
        variant="ghost"
        size="md"
        radius="xl"
        aria-label="Open composer actions"
        isDisabled={disabled}
        data-testid="composer-action-menu-trigger"
        className={triggerClassName}
      >
        <Plus className={triggerIconClassName} aria-hidden="true" />
      </IconButton>
      <StudioDialogPopover
        placement="top start"
        layout="menu"
        className="w-64"
        data-testid="composer-action-menu"
      >
        {view === "commands" ? (
          <div className="space-y-1" onKeyDown={moveRowFocus}>
            <ActionRow
              icon={<NavArrowLeft className="h-4 w-4" aria-hidden="true" />}
              title="Commands"
              onPress={() => setView("main")}
            />
            {visibleCommands.map((command) => (
              <ActionRow
                key={command.command}
                icon={<Terminal className="h-4 w-4" aria-hidden="true" />}
                title={command.command}
                onPress={() => {
                  closeMenu();
                  onInsertCommand(command.command);
                }}
                testId={commandTestId(command.command)}
              />
            ))}
          </div>
        ) : view === "connect" && onSelectConnector ? (
          <div className="space-y-1" onKeyDown={moveRowFocus}>
            <ActionRow
              icon={<NavArrowLeft className="h-4 w-4" aria-hidden="true" />}
              title="Connect a tool"
              onPress={() => setView("main")}
              testId="composer-action-menu-connect-back"
            />
            {AVAILABLE_FEATURED_CONNECTORS.map((connector) => {
              const Mark = connector.mark;
              const installed =
                connector.kind === "skill" && installedSkillNames.has(connector.skillName);
              return (
                <ActionRow
                  key={connector.id}
                  icon={<Mark className="h-4 w-4" aria-hidden="true" />}
                  title={connector.name}
                  end={
                    installed ? (
                      <Badge tone="success" size="xs">
                        Connected
                      </Badge>
                    ) : undefined
                  }
                  onPress={() => {
                    closeMenu();
                    onSelectConnector(connector);
                  }}
                  testId={`composer-action-menu-connect-${connector.id}`}
                />
              );
            })}
            {onBrowseConnectors ? (
              <ActionRow
                icon={<Search className="h-4 w-4" aria-hidden="true" />}
                title="Browse all tools"
                onPress={() => {
                  closeMenu();
                  onBrowseConnectors();
                }}
                testId="composer-action-menu-connect-browse"
              />
            ) : null}
          </div>
        ) : (
          <div className="space-y-1" onKeyDown={moveRowFocus}>
            {onExpandDraft ? (
              <ActionRow
                icon={<Expand className="h-4 w-4" aria-hidden="true" />}
                title="Expand draft"
                onPress={() => { closeMenu(); onExpandDraft(); }}
                testId="composer-action-menu-expand-draft"
              />
            ) : null}
            {onInsertSuggestion ? (
              <ActionRow
                icon={<MagicWand className="h-4 w-4" aria-hidden="true" />}
                title="Insert suggestion"
                onPress={() => {
                  closeMenu();
                  onInsertSuggestion();
                }}
                testId="composer-action-menu-insert-suggestion"
              />
            ) : null}
            {!mutationDisabled && onUploadImage ? (
              <ActionRow
                icon={<MediaImage className="h-4 w-4" aria-hidden="true" />}
                title="Upload image"
                onPress={() => {
                  closeMenu();
                  onUploadImage();
                }}
                disabled={uploadImageDisabled || Boolean(uploadImageUnavailableReason)}
                description={uploadImageUnavailableReason ?? undefined}
                hoverTitle={uploadImageUnavailableReason ?? undefined}
                testId="composer-action-menu-upload-image"
              />
            ) : null}
            {!mutationDisabled && onStartVoiceInput ? (
              <ActionRow
                icon={<Microphone className="h-4 w-4" aria-hidden="true" />}
                title="Dictate message"
                onPress={() => {
                  closeMenu();
                  onStartVoiceInput();
                }}
                disabled={voiceInputDisabled}
                testId="composer-action-menu-voice-input"
              />
            ) : null}
            {!mutationDisabled && onToggleVoiceReplies ? (
              <ActionRow
                icon={voiceRepliesEnabled ? (
                  <SoundHigh className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <SoundOff className="h-4 w-4" aria-hidden="true" />
                )}
                title={voiceRepliesEnabled ? "Turn off spoken replies" : "Turn on spoken replies"}
                onPress={() => {
                  closeMenu();
                  onToggleVoiceReplies();
                }}
                disabled={voiceRepliesDisabled}
                testId="composer-action-menu-voice-replies"
              />
            ) : null}
            {(onInsertSuggestion || (!mutationDisabled && (onUploadImage || onStartVoiceInput || onToggleVoiceReplies))) &&
            (!mutationDisabled || showInviteAction) ? (
              <StudioMenuSeparator />
            ) : null}
            {!mutationDisabled && onQueueMessage ? (
              <ActionRow
                icon={<Send className="h-4 w-4" aria-hidden="true" />}
                title="Queue message"
                onPress={() => {
                  closeMenu();
                  onQueueMessage();
                }}
                end={
                  <Text as="kbd" variant="captionSmall" tone="inherit" aria-label={`${commandKeyLabel} plus Enter`} className="font-sans">
                    {commandKeyLabel} ↵
                  </Text>
                }
                disabled={queueDisabled}
                testId="composer-action-menu-queue"
              />
            ) : null}
            {!mutationDisabled && onStashDraft ? (
              <ActionRow
                icon={<Bookmark className="h-4 w-4" aria-hidden="true" />}
                title="Stash draft"
                onPress={() => {
                  closeMenu();
                  onStashDraft();
                }}
                end={
                  <Text as="kbd" variant="captionSmall" tone="inherit" aria-label={`${commandKeyLabel} plus Shift plus Enter`} className="font-sans">
                    {commandKeyLabel} ⇧ ↵
                  </Text>
                }
                disabled={stashDisabled}
                testId="composer-action-menu-stash"
              />
            ) : null}
            {!mutationDisabled && (onQueueMessage || onStashDraft) ? (
              <>
                <Text
                  variant="captionSmall"
                  tone="muted"
                  className="px-2.5 py-1"
                  data-testid="composer-action-menu-enter-hint"
                >
                  Enter sends or steers · ⇧Enter adds a line
                </Text>
                <StudioMenuSeparator />
              </>
            ) : null}
            {!mutationDisabled ? (
              <ActionRow
                icon={<Github className="h-4 w-4" aria-hidden="true" />}
                title="Import GitHub repo"
                onPress={() => {
                  closeMenu();
                  onImportGithubRepo();
                }}
                testId="composer-action-menu-import-github"
              />
            ) : null}
            {!mutationDisabled && onSelectConnector ? (
              <ActionRow
                icon={<PlugTypeC className="h-4 w-4" aria-hidden="true" />}
                title="Connect a tool"
                onPress={() => setView("connect")}
                end={<NavArrowRight className="h-4 w-4" aria-hidden="true" />}
                testId="composer-action-menu-connect"
              />
            ) : null}
            {!mutationDisabled && showBrowserAction ? (
              <ActionRow
                icon={<Safari className="h-4 w-4" aria-hidden="true" />}
                title="Open browser"
                onPress={() => {
                  closeMenu();
                  onOpenBrowser();
                }}
                testId="composer-action-menu-open-browser"
              />
            ) : null}
            {!mutationDisabled && showNewBrowserAction ? (
              <ActionRow
                icon={<OpenNewWindow className="h-4 w-4" aria-hidden="true" />}
                title="Ask AI for a new tab"
                description="Uses your next message to request another tab."
                onPress={() => {
                  closeMenu();
                  onOpenNewBrowser();
                }}
                end={
                  pendingNewBrowser ? (
                    <Badge tone="info" size="xs">
                      Next
                    </Badge>
                  ) : null
                }
                testId="composer-action-menu-open-new-browser"
              />
            ) : null}
            {showInviteAction ? (
              <ActionRow
                icon={<Group className="h-4 w-4" aria-hidden="true" />}
                title={inviteActionLabel}
                onPress={() => {
                  closeMenu();
                  onOpenInvite();
                }}
                testId="composer-action-menu-invite"
              />
            ) : null}
            {!mutationDisabled ? (
              <ActionRow
                icon={<Terminal className="h-4 w-4" aria-hidden="true" />}
                title="Commands"
                onPress={() => setView("commands")}
                end={<NavArrowRight className="h-4 w-4" aria-hidden="true" />}
                testId="composer-action-menu-commands"
              />
            ) : null}
          </div>
        )}
      </StudioDialogPopover>
    </DialogTrigger>
  );
}
