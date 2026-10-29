import type { ComponentProps } from "react";
import { Plus } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { DARK_RAIL_HOVER_CLASS } from "../../../theme/darkSurfaces";
import { useWorkspaceControls } from "../workspaceControls";

type StudioNewChatButtonProps = {
  testId?: string;
  className?: string;
  size?: ComponentProps<typeof IconButton>["size"];
  radius?: ComponentProps<typeof IconButton>["radius"];
  onStarted?: () => void;
  /** Run creation after a navigation owner dismisses its drawer. */
  runAction?: (action: () => void) => void;
  label?: string;
  isDisabled?: boolean;
};

/**
 * One way to start a chat: a press makes one at once, wherever the button
 * sits (the tab bar, the sidebar, the top bar). A private chat starts from the
 * composer's invite menu, with the teammate it is for.
 */
export function StudioNewChatButton({
  testId = "topbar-new-conversation",
  className = `h-10 w-10 rounded-full border border-transparent bg-transparent shadow-none focus-visible:ring-white/16 focus-visible:ring-offset-white dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)] ${DARK_RAIL_HOVER_CLASS}`,
  size = "md",
  radius = "full",
  onStarted,
  runAction,
  label,
  isDisabled = false,
}: StudioNewChatButtonProps) {
  const { onStartNewConversation, showChatActions = false } = useWorkspaceControls();
  if (!showChatActions || !onStartNewConversation) {
    return null;
  }
  const startConversation = () => {
    const start = () => { onStartNewConversation(); onStarted?.(); };
    if (runAction) runAction(start);
    else start();
  };

  return (
    <IconButton
      type="button"
      variant="ghost"
      size={size}
      radius={radius}
      isDisabled={isDisabled}
      aria-label="New chat"
      title="New chat"
      data-testid={testId}
      className={className}
      onPress={startConversation}
    >
      <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
      {label ? <span className="truncate">{label}</span> : null}
    </IconButton>
  );
}
