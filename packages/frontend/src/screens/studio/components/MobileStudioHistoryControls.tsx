import { NavArrowLeft, NavArrowRight } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import type { StudioHistory } from "../../../navigation/useStudioHistory";
import { useStudioSearchReturn } from "./StudioSearchReturnContext";

/** Compact surfaces share the layout's history owner, including when a chat
 * moves the controls into its menu to leave the composer as its main exit. */
export function MobileStudioHistoryControls({ history, returnToSearch = true, onNavigate }: {
  history: StudioHistory;
  returnToSearch?: boolean;
  onNavigate?: () => void;
}) {
  const searchReturn = useStudioSearchReturn();
  const hasResults = returnToSearch && Boolean(searchReturn.originToken);
  if (!hasResults && !history.canGoBack && !history.canGoForward) return null;
  const backLabel = hasResults ? "Back to results" : "Go back";

  return <div role="group" aria-label="App history" className="flex shrink-0 items-center" data-testid="mobile-history-controls">
    <Button
      variant="ghost" size="icon" className="!min-h-12 !min-w-12 shrink-0 gap-1 px-2"
      aria-label={backLabel} title={backLabel}
      data-testid={hasResults ? "mobile-header-results" : "mobile-header-back"}
      isDisabled={!hasResults && !history.canGoBack}
      onPress={() => {
        onNavigate?.();
        if (hasResults) searchReturn.returnToResults();
        else history.goBack();
      }}
    >
      <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
      <span className={hasResults ? "text-sm" : "sr-only"}>{hasResults ? "Results" : "Back"}</span>
    </Button>
    <IconButton
      variant="ghost" className="!min-h-12 !min-w-12 shrink-0"
      aria-label="Go forward" title="Go forward" data-testid="mobile-header-forward"
      isDisabled={!history.canGoForward}
      onPress={() => { onNavigate?.(); history.goForward(); }}
    >
      <NavArrowRight className="h-5 w-5" aria-hidden="true" />
    </IconButton>
  </div>;
}
