import { Text } from "../../../components/Text";

/** Keep connection diagnostics available without making them the primary guidance. */
export function BrowserUnavailableNotice({ error, compact = false }: { error: string | null; compact?: boolean }) {
  const needsSetup = /provider\s+['"][^'"]+['"]\s+is not configured/i.test(error ?? "");
  return <div className="min-w-0 space-y-2">
    <div className="space-y-1">
      <Text as="p" variant="bodyStrong" tone="primary">Browser unavailable</Text>
      <Text as="p" variant={compact ? "caption" : "body"} tone="muted" className="leading-snug">
        {needsSetup
          ? "Browsing hasn't been set up for this workspace. Ask your administrator to connect a browser runtime."
          : "The browser couldn't connect. Try again in a moment."}
      </Text>
    </div>
    {error ? <details className="text-xs text-slate-500 dark:text-slate-400">
      <summary className="w-fit cursor-pointer rounded-md py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500">Technical details</summary>
      <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
    </details> : null}
  </div>;
}
