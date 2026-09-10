import { ArrowDown } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";

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
    {loadingNewer ? <span role="status" className="inline-flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <Spinner aria-hidden="true" tone="slate" size="sm" />Loading messages…
    </span> : null}
    {newerError ? <>
      <span role="alert" className="w-full min-w-0 break-words text-center text-sm text-slate-500 dark:text-slate-400">{newerError}</span>
      <Button variant="outline" size="xs" className="max-[899px]:min-h-11" onPress={onLoadNewer}
        isDisabled={loadingNewer} aria-label="Retry loading newer messages" data-testid="chat-message-load-newer">Retry</Button>
    </> : null}
    <span className={hideLatest ? "invisible" : undefined} aria-hidden={hideLatest || undefined}>
    <Button variant="ghost" size="xs" className="max-[899px]:min-h-11" onPress={onReturnToLatest}
      isDisabled={hideLatest || !canReturnToLatest}
      aria-label="Jump to latest" data-testid="chat-message-return-latest">
      Latest<ArrowDown aria-hidden="true" className="h-4 w-4" />
    </Button>
    </span>
  </div>;
}
