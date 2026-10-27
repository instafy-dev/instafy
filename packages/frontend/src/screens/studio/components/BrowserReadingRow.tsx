import { useId } from "react";
import { Button } from "../../../components/Button";
import type { BrowserSessionPage } from "./browserSessionPages";
import {
  BROWSER_AGENT_DEFAULT_NAME,
  browserReadingHost,
  browserReadingTitle,
  sharedBrowserAgentTabLabel,
} from "./browserAgentTabs";

/**
 * The mark on a tab the agent holds, in the same violet as "<agent> has
 * control". It names the agent so the tab is never mistaken for the person's;
 * on a tab the agent opened in the Shared Browser it shows that tab's label
 * ("Octo's tab 2"), the one its prompts use.
 */
export function BrowserAgentTabBadge({ agentName = BROWSER_AGENT_DEFAULT_NAME, label, className = "" }: {
  agentName?: string;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-4 ${label ? "max-w-24" : "max-w-20"} flex-none items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 text-[10px] font-semibold leading-none text-violet-700 dark:text-violet-300 ${className}`}
      data-testid="browser-agent-tab-badge"
      title={`${agentName} opened or is using this tab`}
    >
      <span className="truncate">{label ?? agentName}</span>
    </span>
  );
}

/**
 * One compact row while the agent holds the browser: the pages it is reading
 * (host and title, as text) and one Take over button. Take over is the same
 * action as the browser's own Take over: it revokes the agent's control of
 * every tab, not just the one on screen.
 */
export function BrowserReadingRow({
  pages,
  agentName = BROWSER_AGENT_DEFAULT_NAME,
  canTakeOver,
  takingOver = false,
  error = null,
  onTakeOver,
}: {
  pages: readonly BrowserSessionPage[];
  agentName?: string;
  canTakeOver: boolean;
  takingOver?: boolean;
  error?: string | null;
  onTakeOver: () => void;
}) {
  const labelId = useId();
  if (pages.length === 0) return null;
  const count = pages.length === 1 ? "1 page" : `${pages.length} pages`;
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-800"
      data-browser-session-safe-zone="true"
      data-testid="browser-reading-row"
    >
      <span id={labelId} className="flex-none font-medium text-slate-600 dark:text-slate-300">
        {agentName} is reading<span className="sr-only"> {count}</span>
      </span>
      <ul
        aria-labelledby={labelId}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pages.map((page) => {
          const host = browserReadingHost(page);
          const title = browserReadingTitle(page);
          // A tab the agent opened is named as its prompts name it.
          const tabLabel = page.openedBy === "agent" && page.agentTabNumber ? `${sharedBrowserAgentTabLabel(page)}: ` : "";
          return (
            <li
              key={page.id}
              className="inline-flex min-w-0 max-w-[11rem] flex-none items-center sm:max-w-[16rem] gap-1 rounded-full border border-violet-500/25 bg-violet-500/5 px-2 py-0.5 text-slate-700 dark:text-slate-200"
              data-testid="browser-reading-page"
              title={`${tabLabel}${page.title ? `${page.title}\n${page.url}` : page.url}`}
            >
              {tabLabel ? <span className="sr-only">{tabLabel}</span> : null}
              <span className="flex-none font-medium">{host}</span>
              {title ? <span className="truncate text-slate-500 dark:text-slate-400">· {title}</span> : null}
            </li>
          );
        })}
      </ul>
      {canTakeOver ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          radius="full"
          className="flex-none"
          isDisabled={takingOver}
          onPress={onTakeOver}
          data-testid="browser-reading-takeover"
          title={`Stop ${agentName} and use every tab yourself`}
        >
          {takingOver ? "Stopping AI…" : "Take over"}
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="max-w-48 flex-none truncate text-rose-600 dark:text-rose-300" title={error}>{error}</span>
      ) : null}
    </div>
  );
}
