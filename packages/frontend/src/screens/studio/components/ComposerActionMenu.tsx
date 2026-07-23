import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Github,
  Group,
  NavArrowLeft,
  NavArrowRight,
  OpenNewWindow,
  Plus,
  Safari,
  Terminal,
} from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { CHAT_SLASH_COMMANDS } from "../../../conversations/slashCommands";

type ComposerActionMenuView = "main" | "commands";

function commandTestId(command: string): string {
  const normalized = command.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return `composer-action-menu-command-${normalized || "root"}`;
}

function ActionRow({
  icon,
  title,
  onPress,
  end,
  testId,
}: {
  icon: ReactNode;
  title: string;
  onPress: () => void;
  end?: ReactNode;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      radius="xl"
      onPress={onPress}
      className="h-11 w-full justify-start px-2.5 text-left"
      data-testid={testId}
    >
      <span className="flex w-full items-center gap-3">
        <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-700 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-200">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <Text as="span" variant="bodyStrong" tone="primary" className="truncate text-sm">
            {title}
          </Text>
          {end ? <span className="flex-none text-slate-400 dark:text-slate-500">{end}</span> : null}
        </span>
      </span>
    </Button>
  );
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
  onInsertCommand,
  triggerClassName,
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
  onInsertCommand: (command: string) => void;
  triggerClassName?: string;
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

  const visibleCommands = useMemo(
    () => CHAT_SLASH_COMMANDS.filter((command) => !command.hidden),
    [],
  );

  return (
    <DialogTrigger isOpen={open} onOpenChange={handleOpenChange}>
      <IconButton
        type="button"
        variant="outline"
        size="md"
        radius="xl"
        aria-label="Open composer actions"
        isDisabled={disabled}
        data-testid="composer-action-menu-trigger"
        className={triggerClassName}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <StudioDialogPopover
        placement="top start"
        offset={10}
        className="w-[min(15rem,calc(100vw-1.25rem))] p-2"
        data-testid="composer-action-menu"
      >
        {view === "commands" ? (
          <div className="space-y-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              radius="xl"
              onPress={() => setView("main")}
              className="mb-1 justify-start px-2.5 text-left"
            >
              <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
              Commands
            </Button>
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
        ) : (
          <div className="space-y-1">
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
                title="New shared site"
                onPress={() => {
                  closeMenu();
                  onOpenNewBrowser();
                }}
                end={
                  pendingNewBrowser ? (
                    <span className="rounded-full border border-primary-500/25 bg-primary-500/10 px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-[0.14em] text-primary-600 dark:text-primary-300">
                      Next
                    </span>
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
