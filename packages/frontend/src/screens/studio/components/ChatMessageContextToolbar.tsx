import { ArrowLeft } from "iconoir-react";
import { Button } from "../../../components/Button";
import { ChatColumn } from "./ChatColumn";
import { useStudioSearchReturn } from "./StudioSearchReturnContext";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

export function ChatMessageContextToolbar({ messageTargetActive, findingMessage, canReturnToLatest, onReturnToLatest }: {
  messageTargetActive: boolean;
  findingMessage: boolean;
  canReturnToLatest: boolean;
  onReturnToLatest: () => void;
}) {
  const searchReturn = useStudioSearchReturn();
  const isLargeScreen = useStudioDesktopLayout();
  const showSearchReturn = isLargeScreen && Boolean(searchReturn.originToken);
  if (!messageTargetActive && !showSearchReturn) return null;
  return <div className="flex-none px-3 sm:px-4">
    <ChatColumn className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm text-slate-500 dark:text-slate-400">
      {showSearchReturn ? <Button variant="ghost" size="xs" onPress={searchReturn.returnToResults} data-testid="chat-back-to-search-results">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />Back to results
      </Button> : null}
      <span role="status" data-testid="chat-message-context">
        {messageTargetActive ? findingMessage ? "Finding message…" : searchReturn.originToken ? "Search result" : "Earlier message" : "Latest messages"}
      </span>
      {messageTargetActive ? <Button variant="ghost" size="xs" className="max-[899px]:min-h-11" onPress={onReturnToLatest} isDisabled={!canReturnToLatest} data-testid="chat-message-return-latest">Jump to latest</Button> : null}
    </ChatColumn>
  </div>;
}
