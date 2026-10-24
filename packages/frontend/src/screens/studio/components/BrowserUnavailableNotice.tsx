import { Text } from "../../../components/Text";
import { runtimeDebugEnabled } from "../../../runtime/utils/runtimeDebug";

/**
 * The one sentence the browser view shows when it is not live. The raw
 * reason stays out of the way: it is in `data-debug-reason`, and under
 * Technical details only while runtime debug is on.
 */
export function BrowserUnavailableNotice({
  sentence,
  reason,
  compact = false,
}: {
  sentence: string;
  reason: string | null;
  compact?: boolean;
}) {
  const showDetails = Boolean(reason) && reason !== sentence && runtimeDebugEnabled();
  return <div className="min-w-0 space-y-2" data-debug-reason={reason ?? undefined}>
    <Text as="p" variant={compact ? "caption" : "body"} tone="primary" className="leading-snug"
      data-testid="browser-session-view-sentence">
      {sentence}
    </Text>
    {showDetails ? <details className="text-xs text-slate-500 dark:text-slate-400">
      <summary className="w-fit cursor-pointer rounded-md py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500">Technical details</summary>
      <p className="mt-1 whitespace-pre-wrap break-words">{reason}</p>
    </details> : null}
  </div>;
}
