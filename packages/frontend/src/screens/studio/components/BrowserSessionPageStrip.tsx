import { useMemo, useState, type ReactNode } from "react";
import { NavArrowDown, Plus, Safari, Xmark } from "iconoir-react";
import { CHAT_COLUMN_CLASS_NAME } from "./ChatColumn";
import type { BrowserSessionPage } from "./browserSessionPages";

const COLLAPSED_PAGE_LIMIT = 3;

export function resolveCollapsedBrowserSessionPages(
  pages: BrowserSessionPage[],
  limit = COLLAPSED_PAGE_LIMIT,
): BrowserSessionPage[] {
  if (pages.length <= limit) {
    return pages;
  }

  const activeIndex = pages.findIndex((page) => page.isActive);
  if (activeIndex < 0) {
    return pages.slice(0, limit);
  }

  const halfWindow = Math.floor((limit - 1) / 2);
  const maxStart = Math.max(0, pages.length - limit);
  const start = Math.min(Math.max(activeIndex - halfWindow, 0), maxStart);
  return pages.slice(start, start + limit);
}

function BrowserShelfChip({
  children,
  className,
  onClick,
  testId,
  pressed = false,
  title,
}: {
  children: ReactNode;
  className: string;
  onClick?: () => void;
  testId?: string;
  pressed?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      data-testid={testId}
      aria-pressed={pressed}
      title={title}
    >
      {children}
    </button>
  );
}

export function BrowserSessionPageStrip({
  pages,
  onSelectPage,
  onToggleBrowser,
  onClearPendingNewBrowser,
  browserHidden,
  browserOpen,
  pendingNewBrowser,
}: {
  pages: BrowserSessionPage[];
  onSelectPage: (pageId: string) => void;
  onToggleBrowser: () => void;
  onClearPendingNewBrowser: () => void;
  browserHidden: boolean;
  browserOpen: boolean;
  pendingNewBrowser: boolean;
}) {
  const [expandedDeck, setExpandedDeck] = useState(false);

  const collapsedPages = useMemo(() => {
    return resolveCollapsedBrowserSessionPages(pages);
  }, [pages]);

  if (pages.length === 0 && !pendingNewBrowser && !browserHidden) {
    return null;
  }

  const visiblePages = expandedDeck ? pages : collapsedPages;
  const hiddenPageCount = Math.max(0, pages.length - visiblePages.length);
  const showDeckChip = pages.length > COLLAPSED_PAGE_LIMIT;
  const showBrowserChip = browserHidden && pages.length === 0;

  return (
    <div
      className={[
        "px-3 pb-2 sm:px-4",
        browserOpen && !browserHidden ? "pt-2.5 sm:pt-3" : "pt-1.5 sm:pt-2",
      ].join(" ")}
      data-browser-session-safe-zone="true"
    >
      <div className={CHAT_COLUMN_CLASS_NAME}>
        <div
          className="flex items-center gap-2.5 overflow-x-auto px-1 py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="browser-session-page-strip"
        >
          {showBrowserChip ? (
            <BrowserShelfChip
              onClick={onToggleBrowser}
              testId="browser-session-page-browser"
              className={[
                "inline-flex h-10 min-w-fit shrink-0 items-center gap-2.5 rounded-full border pl-3 pr-3.5 text-left shadow-sm transition",
                browserOpen && !browserHidden
                  ? "border-primary-500/45 bg-primary-500/10 text-primary-700 hover:border-primary-500/60 hover:bg-primary-500/14 dark:border-primary-400/45 dark:bg-primary-500/15 dark:text-primary-200 dark:hover:border-primary-300/60 dark:hover:bg-primary-500/20"
                  : "border-slate-200/70 bg-white/95 text-slate-900 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/95 dark:text-slate-100 dark:hover:border-slate-700 dark:hover:bg-slate-900",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950",
              ].join(" ")}
            >
              <Safari
                className={[
                  "h-4 w-4 flex-none",
                  browserOpen && !browserHidden
                    ? "text-primary-600 dark:text-primary-200"
                    : "text-slate-500 dark:text-slate-300",
                ].join(" ")}
                aria-hidden="true"
              />
              <span className="truncate text-sm font-medium">Browser</span>
            </BrowserShelfChip>
          ) : null}

          {visiblePages.map((page) => {
            const current = page.isActive;
            const handleChipClick =
              current && browserOpen && !browserHidden ? onToggleBrowser : () => onSelectPage(page.id);
            const chipClassName = [
              "inline-flex h-10 min-w-fit max-w-[13rem] shrink-0 items-center gap-2 rounded-full border px-2.5 pr-3 text-left shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950",
              current
                ? "border-emerald-500/35 bg-emerald-500/8 text-slate-900 dark:border-emerald-400/35 dark:bg-emerald-500/10 dark:text-slate-100"
                : "border-slate-200/70 bg-white/95 text-slate-900 dark:border-slate-800 dark:bg-slate-950/95 dark:text-slate-100",
              current
                ? "hover:border-emerald-500/55 hover:bg-emerald-500/12"
                : "hover:border-slate-300 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-900",
            ].join(" ");
            return (
              <BrowserShelfChip
                key={page.id}
                onClick={handleChipClick}
                testId="browser-session-page-chip"
                pressed={current}
                title={page.title || page.url}
                className={chipClassName}
              >
                <span
                  className={[
                    "inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border",
                    current
                      ? "border-emerald-500/20 bg-emerald-500/10"
                      : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900",
                  ].join(" ")}
                >
                  <Safari className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{page.label}</span>
                  {current ? (
                    <span className="inline-flex h-2 w-2 flex-none rounded-full bg-emerald-500 dark:bg-emerald-400" />
                  ) : null}
                </span>
              </BrowserShelfChip>
            );
          })}

        {showDeckChip ? (
          <BrowserShelfChip
            onClick={() => setExpandedDeck((current) => !current)}
            testId="browser-session-page-overflow"
            className={[
              "inline-flex h-10 min-w-fit shrink-0 items-center gap-2 rounded-full border px-3.5 text-left shadow-sm transition",
              "border-dashed border-slate-300/90 bg-white/92 text-slate-900 hover:border-slate-400 hover:bg-slate-50",
              "dark:border-slate-700 dark:bg-slate-950/92 dark:text-slate-100 dark:hover:border-slate-600 dark:hover:bg-slate-900",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950",
            ].join(" ")}
          >
            <span className="relative inline-flex h-7 w-7 flex-none items-center justify-center">
              <span className="absolute inset-[2px] translate-x-[4px] rounded-full border border-slate-200/70 bg-slate-50 dark:border-slate-800 dark:bg-slate-900" />
              <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
                <Plus className="h-4 w-4" aria-hidden="true" />
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{expandedDeck ? "Less" : `+${hiddenPageCount}`}</span>
              <NavArrowDown
                className={`h-3.5 w-3.5 text-slate-500 transition-transform dark:text-slate-400 ${expandedDeck ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </span>
          </BrowserShelfChip>
        ) : null}

        {pendingNewBrowser ? (
          <button
            type="button"
            onClick={onClearPendingNewBrowser}
            className="inline-flex h-10 min-w-fit shrink-0 items-center gap-2 rounded-full border border-primary-500/45 bg-primary-500/10 px-3.5 text-left text-primary-700 shadow-sm transition hover:border-primary-500/60 hover:bg-primary-500/14 dark:border-primary-400/45 dark:bg-primary-500/15 dark:text-primary-200 dark:hover:border-primary-300/60 dark:hover:bg-primary-500/20"
            data-testid="browser-session-page-new-pending"
            aria-label="Clear next new site target"
            title="Clear next new site target"
          >
            <span className="truncate text-sm font-medium">New shared site</span>
            <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-current/15 text-primary-600/75 dark:text-primary-200/75">
              <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </button>
        ) : null}
        </div>
      </div>
    </div>
  );
}
