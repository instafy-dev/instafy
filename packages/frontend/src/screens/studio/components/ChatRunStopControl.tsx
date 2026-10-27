import { useRef, useState } from "react";
import { MenuTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogBody } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import type { ChatRunStopController } from "./useChatRunStop";

export function ChatRunStopControl({ controller, className, iconClassName = "h-[22px] w-[22px]" }: {
  controller: ChatRunStopController;
  className?: string;
  iconClassName?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  if (!controller.visible) return null;
  const busy = controller.phase === "stopping" || controller.phase === "requested";
  const retrying = controller.phase === "error";
  const label = controller.phase === "stopping" ? "Stopping…"
    : controller.phase === "requested" ? "Stop requested"
      : retrying ? "Retry stop" : "Stop";
  const content = <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={iconClassName}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>;
  const confirmationNames = [...new Set(controller.confirmationTargets?.map((target) => target.agentDisplayName) ?? [])].join(" and ");
  const buttonProps = {
    "data-testid": "chat-run-stop-button",
    type: "button" as const,
    variant: "ghost" as const,
    tone: "neutral" as const,
    size: "md" as const,
    radius: "xl" as const,
    className,
    isPending: controller.phase === "stopping",
    isDisabled: controller.phase === "requested",
    "aria-label": label,
    title: label === "Stop" ? "Stop (Esc)" : label,
    "aria-describedby": controller.error ? controller.feedbackId : undefined,
    "aria-keyshortcuts": !busy && !retrying ? "Escape" : undefined,
    ref: triggerRef,
  };
  return (
    <span className="relative inline-flex max-w-full flex-none items-center" data-testid="chat-run-stop-control">
      {controller.groups.length > 1 && !busy && !retrying ? (
        <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
          <IconButton {...buttonProps}>{content}</IconButton>
          <StudioPopover triggerRef={triggerRef} placement="top end" layout="menu">
            <StudioMenu aria-label="Stop active turns" onAction={(key) => {
              setMenuOpen(false);
              if (key === "all") controller.requestStop(controller.targets);
              else {
                const group = controller.groups.find((candidate) => `agent:${candidate.handle}` === key);
                if (group) controller.requestStop(group.targets);
              }
            }}>
              {controller.groups.map((group) => <StudioMenuItem id={`agent:${group.handle}`} key={group.handle}>Stop {group.label}</StudioMenuItem>)}
              <StudioMenuSeparator />
              <StudioMenuItem id="all">{controller.groups.length === 2 ? "Stop both" : "Stop all"}</StudioMenuItem>
            </StudioMenu>
          </StudioPopover>
        </MenuTrigger>
      ) : (
        <IconButton {...buttonProps} onPress={() => retrying ? controller.retry() : controller.requestStop()}>{content}</IconButton>
      )}
      <StudioDialogModal
        isOpen={Boolean(controller.confirmationTargets)}
        onOpenChange={(open) => { if (!open) controller.dismissConfirmation(); }}
        isDismissable
        dialogAriaLabel="Stop another person's turn?"
        size="sm"
        gutter="responsive"
        layout="editor"
      >
        <StudioDialogBody scrollable>
          <Text as="h2" variant="subtitle" tone="primary" className="break-words">Stop {confirmationNames}?</Text>
          <Text as="p" variant="body" tone="muted" className="mt-2">This includes a turn started by someone else, or whose owner could not be verified.</Text>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button autoFocus variant="ghost" preset="form" onPress={controller.dismissConfirmation}>Keep working</Button>
            <Button variant="secondary" preset="form" className="min-w-0 max-w-full [overflow-wrap:anywhere]" onPress={controller.confirmStop}>Stop {confirmationNames}</Button>
          </div>
        </StudioDialogBody>
      </StudioDialogModal>
    </span>
  );
}

/** Keep feedback inside the composer, below its controls and above attachments. */
export function ChatRunStopFeedback({ controller }: { controller: ChatRunStopController }) {
  if (!controller.visible || controller.phase !== "error" || !controller.error) return null;
  return <Text as="div" variant="caption" tone="muted" role="alert" id={controller.feedbackId}
    className="min-w-0 max-w-full break-words px-2 pb-1 pt-1" data-testid="chat-run-stop-error">{controller.error}</Text>;
}
