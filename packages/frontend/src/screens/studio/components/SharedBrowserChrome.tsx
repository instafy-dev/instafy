import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavArrowLeft, NavArrowRight, Refresh } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import type { BrowserSessionPage } from "./browserSessionPages";
import { normalizeBrowserAddress } from "./browserAddress";
import { BrowserAddressField } from "./BrowserAddressField";
import { BrowserChromeShell } from "./BrowserChromeShell";
import {
  HUMAN_SHARED_BROWSER_CONTROL_OWNER,
  type SharedBrowserControlOwner,
} from "./sharedBrowserControlOwner";

export type SharedBrowserChromeProps = {
  compact?: boolean;
  pages: BrowserSessionPage[];
  resolved: boolean;
  pendingAction: string | null;
  error: string | null;
  onNavigate: (pageId: string, url: string) => void;
  onBack: (pageId: string) => void;
  onForward: (pageId: string) => void;
  onReload: (pageId: string) => void;
  onFocusPage: (pageId: string) => void;
  onClearError: () => void;
  toolbarLeading?: ReactNode;
  toolbarStatus?: ReactNode;
  /** Put compact history and reload controls in the existing browser options menu. */
  toolbarActions?: ReactNode | ((compactNavigation: ReactNode) => ReactNode);
  controlOwner?: SharedBrowserControlOwner;
  interactionEnabled?: boolean;
  controls?: {
    navigate: boolean;
    history: boolean;
    reload: boolean;
    focusPage: boolean;
  };
};

type BrowserSessionPageWithHistory = BrowserSessionPage & {
  canGoBack?: boolean;
  canGoForward?: boolean;
};

export function normalizeSharedBrowserAddress(rawAddress: string): string | null {
  return normalizeBrowserAddress(rawAddress);
}

function pageOptionLabel(page: BrowserSessionPage): string {
  return page.title?.trim() || page.label.trim() || page.host.trim() || page.url;
}

function ChromeButton({
  label,
  disabled,
  onClick,
  testId,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <IconButton
      aria-label={label}
      className="shrink-0 max-[540px]:h-10 max-[540px]:w-10"
      data-testid={testId}
      isDisabled={disabled}
      onPress={onClick}
      radius="full"
      size="sm"
      title={label}
      type="button"
      variant="ghost"
    >
      {children}
    </IconButton>
  );
}

export function SharedBrowserChrome({
  compact = false,
  pages,
  resolved,
  pendingAction,
  error,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onFocusPage,
  onClearError,
  toolbarLeading,
  toolbarStatus,
  toolbarActions,
  controlOwner = HUMAN_SHARED_BROWSER_CONTROL_OWNER,
  interactionEnabled,
  controls = { navigate: true, history: true, reload: true, focusPage: true },
}: SharedBrowserChromeProps) {
  const activePage = useMemo(
    () => pages.find((page) => page.isActive) ?? pages[0] ?? null,
    [pages],
  );
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const submittedAddressRef = useRef<string | null>(null);
  const errorId = useId();
  const [addressDraft, setAddressDraft] = useState(activePage?.url ?? "");
  const [addressError, setAddressError] = useState<string | null>(null);
  const displayedError = addressError ?? error;
  const busy = pendingAction !== null;
  const humanHasControl = interactionEnabled ?? controlOwner.kind === "human";
  const controlsDisabled = !resolved || !activePage || busy || !humanHasControl;
  const historyPage = activePage as BrowserSessionPageWithHistory | null;

  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) {
      setAddressDraft(activePage?.url ?? "");
    }
  }, [activePage?.id, activePage?.url]);

  useEffect(() => {
    if (!error) {
      return;
    }
    submittedAddressRef.current = null;
    if (document.activeElement !== addressInputRef.current) {
      setAddressDraft(activePage?.url ?? "");
    }
  }, [activePage?.url, error]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activePage || controlsDisabled || !controls.navigate) {
      return;
    }
    const normalizedAddress = normalizeSharedBrowserAddress(addressDraft);
    if (!normalizedAddress) {
      setAddressError("Enter an http:// or https:// address.");
      return;
    }
    setAddressError(null);
    if (error) {
      onClearError();
    }
    setAddressDraft(normalizedAddress);
    submittedAddressRef.current = normalizedAddress;
    onNavigate(activePage.id, normalizedAddress);
    addressInputRef.current?.blur();
  };

  const clearDisplayedError = () => {
    setAddressError(null);
    if (error) {
      onClearError();
    }
  };

  const hasNavigationMenu = typeof toolbarActions === "function";
  const historyControls = (
    <span className={compact && !hasNavigationMenu ? "hidden" : "inline-flex items-center gap-0.5"}>
      <ChromeButton
        disabled={controlsDisabled || !controls.history || historyPage?.canGoBack === false}
        label="Back"
        onClick={() => activePage && onBack(activePage.id)}
        testId="shared-browser-back"
      >
        <NavArrowLeft aria-hidden="true" className="h-4 w-4" />
      </ChromeButton>
      <ChromeButton
        disabled={controlsDisabled || !controls.history || historyPage?.canGoForward === false}
        label="Forward"
        onClick={() => activePage && onForward(activePage.id)}
        testId="shared-browser-forward"
      >
        <NavArrowRight aria-hidden="true" className="h-4 w-4" />
      </ChromeButton>
    </span>
  );
  const reloadControl = (
    <ChromeButton
      disabled={controlsDisabled || !controls.reload}
      label="Reload"
      onClick={() => activePage && onReload(activePage.id)}
      testId="shared-browser-reload"
    >
      <Refresh
        aria-hidden="true"
        className={`h-4 w-4 ${pendingAction === "reload" ? "animate-spin" : ""}`}
      />
    </ChromeButton>
  );
  const pageSelectionDisabled = !resolved || busy || !controls.focusPage || !humanHasControl;
  const pageSelect = (
    <select
      aria-label="Shared browser tab"
      aria-description={`${pages.length} tabs. Current tab: ${activePage ? pageOptionLabel(activePage) : "none"}`}
      className={compact
        ? "absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        : "h-8 w-36 shrink-0 truncate rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20 max-[540px]:h-10 pointer-coarse:h-11 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-slate-950 dark:text-slate-200"}
      data-testid="shared-browser-page-select"
      disabled={pageSelectionDisabled}
      onChange={(event) => onFocusPage(event.target.value)}
      title={activePage ? pageOptionLabel(activePage) : "Shared browser tab"}
      value={activePage?.id ?? ""}
    >
      {pages.map((page) => (
        <option key={page.id} value={page.id}>
          {pageOptionLabel(page)}
        </option>
      ))}
    </select>
  );
  // A native picker keeps page selection one tap away on mobile. The compact
  // count avoids squeezing a long page title beside the address field.
  const pageSelector = pages.length > 1 ? (
    compact ? (
      <label
        title={`Switch browser tab (${pages.length} tabs)`}
        data-testid="shared-browser-tabs-picker"
        className={`relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-600 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary-500/50 dark:text-slate-300 ${pageSelectionDisabled ? "opacity-50" : "hover:bg-slate-200/60 dark:hover:bg-slate-800"}`}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border-[1.5px] border-current px-0.5 text-[10px] font-semibold"
        >
          {pages.length}
        </span>
        {pageSelect}
      </label>
    ) : pageSelect
  ) : null;
  const compactNavigation = compact ? (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1" aria-label="Browser navigation">
      {historyControls}
      {reloadControl}
    </div>
  ) : null;

  return (
    <div
      aria-busy={busy || undefined}
      className="w-full min-w-0 shrink-0"
      data-control-owner={controlOwner.kind}
      data-interaction-enabled={humanHasControl ? "true" : "false"}
    >
      <BrowserChromeShell
        label="Shared browser controls"
        compact={compact}
        leading={toolbarLeading}
        navigation={!compact || !hasNavigationMenu ? (
          <div className="flex items-center gap-0.5">
            {historyControls}
            {reloadControl}
          </div>
        ) : null}
        address={
          <div className="flex min-w-0 items-center gap-1">
            {pageSelector}
            <div className="min-w-0 flex-1">
              <BrowserAddressField
                ref={addressInputRef}
                testIdPrefix="shared-browser"
                errorId={displayedError ? `${errorId}-error` : undefined}
                invalid={Boolean(displayedError)}
                disabled={controlsDisabled || !controls.navigate}
                value={addressDraft}
                placeholder={resolved ? "Enter an address" : "Connecting to Shared Browser…"}
                onSubmit={handleSubmit}
                onBlur={(event) => {
                  const nextFocus = event.relatedTarget;
                  if (
                    nextFocus instanceof HTMLElement &&
                    event.currentTarget.form?.contains(nextFocus)
                  ) {
                    return;
                  }
                  const submittedAddress = submittedAddressRef.current;
                  submittedAddressRef.current = null;
                  setAddressDraft(submittedAddress ?? activePage?.url ?? "");
                }}
                onChange={(event) => {
                  setAddressDraft(event.target.value);
                  setAddressError(null);
                  if (error) {
                    onClearError();
                  }
                }}
              />
            </div>
          </div>
        }
        status={toolbarStatus}
        actions={typeof toolbarActions === "function" ? toolbarActions(compactNavigation) : toolbarActions}
        feedback={displayedError}
        feedbackId={`${errorId}-error`}
        feedbackTestId="shared-browser-error"
        feedbackTone="error"
        onDismissFeedback={displayedError ? clearDisplayedError : null}
        busy={busy}
        testId="shared-browser-chrome"
      />

      {pendingAction ? (
        <span className="sr-only" data-testid="shared-browser-pending" role="status">
          Shared browser action in progress: {pendingAction}
        </span>
      ) : null}
    </div>
  );
}
