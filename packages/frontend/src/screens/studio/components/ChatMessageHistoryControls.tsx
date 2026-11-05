import { ArrowDown } from "iconoir-react";
import { Button } from "../../../components/Button";
import { InlineNotice } from "../../../components/InlineNotice";
import { LoadingStatus } from "../../../components/LoadingStatus";

export function ChatMessageHistoryControls({ messageTargetActive, loadingNewer, newerError, canReturnToLatest, onLoadNewer, onReturnToLatest, hideLatest = false }: {
  messageTargetActive: boolean;
  loadingNewer: boolean;
  newerError: string | null;
  canReturnToLatest: boolean;
  onLoadNewer: () => void;
  onReturnToLatest: () => void;
  hideLatest?: boolean;
}) {
  if (!messageTargetActive) return null;
  return <div className="flex flex-wrap items-center justify-center gap-2 py-2">
    {loadingNewer ? <LoadingStatus>Loading messages…</LoadingStatus> : null}
    {newerError ? <>
      <InlineNotice tone="warning" appearance="inline" role="alert" className="w-full">{newerError}</InlineNotice>
      <Button variant="ghost" preset="inline" onPress={onLoadNewer}
        isDisabled={loadingNewer} aria-label="Retry loading newer messages" data-testid="chat-message-load-newer">Retry</Button>
    </> : null}
    <span className={hideLatest ? "invisible" : undefined} aria-hidden={hideLatest || undefined}>
    <Button variant="ghost" preset="inline" onPress={onReturnToLatest}
      isDisabled={hideLatest || !canReturnToLatest}
      aria-label="Jump to latest" data-testid="chat-message-return-latest">
      Latest<ArrowDown aria-hidden="true" className="h-4 w-4" />
    </Button>
    </span>
  </div>;
}
