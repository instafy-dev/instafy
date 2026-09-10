import { ArrowDown } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";

export function ChatMessageHistoryControls({ messageTargetActive, hasNewer, loading, canReturnToLatest, onLoadNewer, onReturnToLatest }: {
  messageTargetActive: boolean;
  hasNewer: boolean;
  loading: boolean;
  canReturnToLatest: boolean;
  onLoadNewer: () => void;
  onReturnToLatest: () => void;
}) {
  if (!messageTargetActive) return null;
  return <div className="flex items-center justify-center gap-2 py-2">
    {hasNewer ? <Button variant="outline" size="xs" className="max-[899px]:min-h-11" onPress={onLoadNewer}
      isDisabled={loading} aria-busy={loading} data-testid="chat-message-load-newer">
      {loading ? <Spinner aria-hidden="true" tone="slate" size="sm" /> : null}
      Load newer messages
    </Button> : null}
    <Button variant="ghost" size="xs" className="max-[899px]:min-h-11" onPress={onReturnToLatest}
      isDisabled={!canReturnToLatest} aria-label="Jump to latest" data-testid="chat-message-return-latest">
      Latest<ArrowDown aria-hidden="true" className="h-4 w-4" />
    </Button>
  </div>;
}
