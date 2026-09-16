import { ChatLines, NavArrowLeft } from "iconoir-react";
import { Button } from "../../../components/Button";
import type { StudioHistory } from "../../../navigation/useStudioHistory";
import { useStudioSearchReturn } from "./StudioSearchReturnContext";

/** Compact mouse and touch layouts share the same destination contract. */
export function MobileWorkspaceBackButton({ history, onOpenChats }: {
  history: StudioHistory;
  onOpenChats: () => void;
}) {
  const searchReturn = useStudioSearchReturn();
  const hasResults = Boolean(searchReturn.originToken);
  const label = hasResults ? "Results" : history.canGoBack ? "Back" : "Chats";
  return (
    <Button
      variant="ghost"
      size="icon"
      className="!min-h-12 !min-w-12 shrink-0 gap-1 px-2"
      aria-label={hasResults ? "Back to results" : history.canGoBack ? "Go back" : "Open chats"}
      title={hasResults ? "Back to results" : history.canGoBack ? "Go back" : "Open chats"}
      data-testid={hasResults ? "mobile-header-results" : history.canGoBack ? "mobile-header-back" : "mobile-header-open-chats"}
      onPress={hasResults ? searchReturn.returnToResults : history.canGoBack ? history.goBack : onOpenChats}
    >
      {hasResults || history.canGoBack
        ? <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
        : <ChatLines className="h-5 w-5" aria-hidden="true" />}
      <span className={hasResults ? "text-sm" : "sr-only"}>{label}</span>
    </Button>
  );
}
