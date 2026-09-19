import { NavArrowRight } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import type { StudioHistory } from "../../../navigation/useStudioHistory";
import { MobileWorkspaceBackButton } from "./MobileWorkspaceBackButton";

/** All compact surfaces use the layout's history owner, including search and
 * global pages. Opening a menu must not be required to return to a later visit. */
export function MobileStudioHistoryControls({ history, onOpenChats, returnToSearch = true }: {
  history: StudioHistory;
  /** Only workspace details offer Chats as their direct-entry destination. */
  onOpenChats?: () => void;
  returnToSearch?: boolean;
}) {
  return <div role="group" aria-label="App history" className="flex shrink-0 items-center empty:hidden" data-testid="mobile-history-controls">
    <MobileWorkspaceBackButton history={history} onOpenChats={onOpenChats} returnToSearch={returnToSearch} />
    {history.canGoForward ? <IconButton
      variant="ghost" className="!min-h-12 !min-w-12 shrink-0"
      aria-label="Go forward" title="Go forward" data-testid="mobile-header-forward"
      onPress={history.goForward}
    >
      <NavArrowRight className="h-5 w-5" aria-hidden="true" />
    </IconButton> : null}
  </div>;
}
