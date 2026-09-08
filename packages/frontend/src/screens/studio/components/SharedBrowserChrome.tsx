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
  toolbarActions?: ReactNode;
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

  return (
    <div
      aria-busy={busy || undefined}
      className="w-full min-w-0 shrink-0"
      data-control-owner={controlOwner.kind}
      data-interaction-enabled={humanHasControl ? "true" : "false"}
    >
      <BrowserChromeShell
        label="Shared browser controls"
        leading={toolbarLeading}
        navigation={
          <div className="flex items-center gap-0.5">
        <span className={compact ? "hidden" : "inline-flex items-center gap-0.5"}>
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
          </div>
        }
        address={
          <div className="flex min-w-0 items-center gap-1">
            {pages.length > 1 ? (
              <select
                aria-label="Shared browser tab"
                className={`h-8 shrink-0 truncate rounded-md border border-slate-200 bg-white text-xs text-slate-700 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20 max-[540px]:h-10 pointer-coarse:h-11 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-slate-950 dark:text-slate-200 ${compact ? "w-10 px-1" : "w-36 px-2"}`}
                data-testid="shared-browser-page-select"
                disabled={!resolved || busy || !controls.focusPage || !humanHasControl}
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
            ) : null}
            <form
              className="relative min-w-0 flex-1"
              data-testid="shared-browser-address-form"
              onSubmit={handleSubmit}
            >
        <label className="sr-only" htmlFor={`${errorId}-address`}>
          Address
        </label>
        <input
          ref={addressInputRef}
          aria-describedby={displayedError ? `${errorId}-error` : undefined}
          aria-invalid={displayedError ? true : undefined}
          aria-label="Address"
          autoCapitalize="none"
          autoComplete="off"
          className="h-8 w-full min-w-0 rounded-full border border-slate-200 bg-white pl-3 pr-9 text-xs text-slate-800 shadow-inner outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20 aria-invalid:border-rose-400 aria-invalid:focus:border-rose-500 aria-invalid:focus:ring-rose-500/20 max-[540px]:h-10 max-[540px]:pr-11 pointer-coarse:h-11 pointer-coarse:pr-12 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-slate-950 dark:text-slate-100"
          data-testid="shared-browser-address"
          disabled={controlsDisabled || !controls.navigate}
          id={`${errorId}-address`}
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
          placeholder={resolved ? "Enter an address" : "Connecting to Shared Browser…"}
          spellCheck={false}
          type="text"
          value={addressDraft}
        />
        <button
          aria-label="Go"
          className="absolute right-0 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 touch-manipulation items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-40 max-[540px]:h-10 max-[540px]:w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11 dark:text-slate-400 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:hover:text-slate-50"
          data-testid="shared-browser-go"
          disabled={controlsDisabled || !controls.navigate}
          title="Go"
          type="submit"
        >
          <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
            </form>
          </div>
        }
        status={toolbarStatus}
        actions={toolbarActions}
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
