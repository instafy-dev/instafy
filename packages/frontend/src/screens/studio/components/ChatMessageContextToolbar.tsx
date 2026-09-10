import { ArrowLeft } from "iconoir-react";
import { Button } from "../../../components/Button";
import { ChatColumn } from "./ChatColumn";
import { useStudioSearchReturn } from "./StudioSearchReturnContext";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

export function ChatMessageContextToolbar() {
  const searchReturn = useStudioSearchReturn();
  const isLargeScreen = useStudioDesktopLayout();
  const showSearchReturn = isLargeScreen && Boolean(searchReturn.originToken);
  if (!showSearchReturn) return null;
  return <div className="flex-none px-3 sm:px-4">
    <ChatColumn className="flex items-center py-1">
      <Button variant="ghost" size="xs" onPress={searchReturn.returnToResults} data-testid="chat-back-to-search-results">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />Back to results
      </Button>
    </ChatColumn>
  </div>;
}
