import { useMemo, useState, type ReactNode } from "react";
import { NavArrowDown, Safari, Xmark } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
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
  className?: string;
  onClick?: () => void;
  testId?: string;
  pressed?: boolean;
  title?: string;
}) {
  return (
    <Button
      type="button"
      preset="inline"
      variant={pressed ? "secondary" : "ghost"}
      onPress={onClick}
      className={["shrink-0 text-left", className].filter(Boolean).join(" ")}
      data-testid={testId}
      aria-pressed={pressed}
      title={title}
    >
      {children}
    </Button>
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
          className="flex items-center gap-2 overflow-x-auto px-1 py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="browser-session-page-strip"
        >
          {showBrowserChip ? (
            <BrowserShelfChip
              onClick={onToggleBrowser}
              testId="browser-session-page-browser"
            >
              <Safari className="h-4 w-4 flex-none" aria-hidden="true" />
              <Text as="span" variant="bodyStrong" tone="inherit" className="truncate">Browser</Text>
            </BrowserShelfChip>
          ) : null}

          {visiblePages.map((page) => {
            const current = page.isActive;
            const handleChipClick =
              current && browserOpen && !browserHidden ? onToggleBrowser : () => onSelectPage(page.id);
            return (
              <BrowserShelfChip
                key={page.id}
                onClick={handleChipClick}
                testId="browser-session-page-chip"
                pressed={current}
                title={page.title || page.url}
                className="max-w-[13rem]"
              >
                <Safari className="h-4 w-4 flex-none" aria-hidden="true" />
                <span className="flex min-w-0 items-center gap-1.5">
                  <Text as="span" variant="bodyStrong" tone="inherit" className="truncate">{page.label}</Text>
                  {current ? (
                    <span aria-hidden="true" className="inline-flex h-2 w-2 flex-none rounded-full bg-emerald-500 dark:bg-emerald-400" />
                  ) : null}
                </span>
              </BrowserShelfChip>
            );
          })}

        {showDeckChip ? (
          <BrowserShelfChip
            onClick={() => setExpandedDeck((current) => !current)}
            testId="browser-session-page-overflow"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Text as="span" variant="bodyStrong" tone="inherit" className="truncate">{expandedDeck ? "Less" : `+${hiddenPageCount}`}</Text>
              <NavArrowDown
                className={`h-3.5 w-3.5 transition-transform ${expandedDeck ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </span>
          </BrowserShelfChip>
        ) : null}

        {pendingNewBrowser ? (
          <Button
            type="button"
            preset="inline"
            variant="ghost"
            tone="accent"
            onPress={onClearPendingNewBrowser}
            className="min-w-fit shrink-0 text-left"
            data-testid="browser-session-page-new-pending"
            aria-label="Cancel new tab request"
            title="Cancel new tab request"
          >
            <Text as="span" variant="bodyStrong" tone="inherit" className="truncate">Next AI request: new tab</Text>
            <Xmark className="h-4 w-4 flex-none" aria-hidden="true" />
          </Button>
        ) : null}
        </div>
      </div>
    </div>
  );
}
