import {
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Computer,
  Globe,
  NavArrowDown,
  NavArrowLeft,
  NavArrowRight,
  Pause,
  Play,
  Refresh,
  Trash,
  MoreHoriz,
} from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { BrowserToolsOverlayContext, BrowserToolsPopover } from "./BrowserToolsPopover";
import { BrowserExpandButton } from "./BrowserExpandButton";
import { BrowserHumanInputStatus } from "./BrowserHumanInputControls";
import { useBrowserHumanInput } from "./useBrowserHumanInput";
import { browserPageOrigin } from "./browserHandoffRouting";
import {
  BrowserChromeShell,
  BrowserStatusPill,
  type BrowserChromeState,
} from "./BrowserChromeShell";
import type {
  BrowserTransport,
  usePersonalBrowserBridge,
} from "./usePersonalBrowserBridge";

type PersonalBrowserModel = ReturnType<typeof usePersonalBrowserBridge>;

export function BrowserTransportSelector({
  checked,
  compact = false,
  mode,
  onModeChange,
  personalAvailable,
}: {
  checked: boolean;
  compact?: boolean;
  mode: BrowserTransport;
  onModeChange: (mode: BrowserTransport) => void;
  personalAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const choose = (next: BrowserTransport) => { setOpen(false); onModeChange(next); };
  const location = mode === "personal" ? "This device" : "Workspace";
  return <div data-browser-session-safe-zone="true" data-testid="browser-transport-selector" data-compact={compact ? "true" : "false"}>
    <BrowserToolsPopover placement="bottom start" label="Browser location" isOpen={open} onOpenChange={setOpen} trigger={
      <Button variant="ghost" size="sm" className="max-[540px]:h-10 pointer-coarse:min-h-11" aria-label={`Browser location: ${location}`} data-testid="browser-location-menu" title={`Runs on ${location.toLowerCase()}`}>
        {mode === "personal" ? <Computer className="h-3.5 w-3.5" aria-hidden="true" /> : <Globe className="h-3.5 w-3.5" aria-hidden="true" />}
        <NavArrowDown className="h-3 w-3" aria-hidden="true" />
      </Button>
    }>
      <p className="font-medium">Run browser on</p>
      <div className="space-y-2" role="group" aria-label="Browser location">
        <Button variant="ghost" className="w-full justify-start" aria-label="This device" aria-pressed={mode === "personal"}
          aria-describedby={`${descriptionId}-personal`} data-testid="browser-transport-personal"
          isDisabled={!checked || !personalAvailable} onPress={() => choose("personal")}>
          <Computer className="h-4 w-4" aria-hidden="true" />This device
        </Button>
        <p id={`${descriptionId}-personal`} className="text-xs text-slate-500 dark:text-slate-400">
          {!checked ? "Checking this device… " : !personalAvailable ? "Available in the Instafy desktop app. " : ""}
          Your logins stay on this device and follow you across projects. They are not copied to Shared Browser or your other devices.
        </p>
        <Button variant="ghost" className="w-full justify-start" aria-label="Workspace browser" aria-pressed={mode === "shared"}
          aria-describedby={`${descriptionId}-shared`} data-testid="browser-transport-shared" onPress={() => choose("shared")}>
          <Globe className="h-4 w-4" aria-hidden="true" />Workspace
        </Button>
        <p id={`${descriptionId}-shared`} className="text-xs text-slate-500 dark:text-slate-400">Project members see the same remote browser and logged-in pages. Your personal logins are not copied here.</p>
      </div>
    </BrowserToolsPopover>
  </div>;
}

function personalBrowserStatus(model: PersonalBrowserModel): {
  state: BrowserChromeState;
  detail: string;
} {
  if (model.recovering) {
    return { state: "starting", detail: "Reopening Personal Browser…" };
  }
  if (model.status?.state === "error") {
    return {
      state: "unavailable",
      detail: model.status.error ?? "Personal Browser is unavailable.",
    };
  }
  if (model.status?.state === "opening") {
    return { state: "starting", detail: "Opening Personal Browser…" };
  }
  if (model.status?.state !== "ready") {
    return { state: "starting", detail: "Preparing Personal Browser…" };
  }
  if (model.agentPhase === "unavailable" && model.agentError) {
    return {
      state: "unavailable",
      detail: model.agentError,
    };
  }
  if (model.status.tabControlActive) {
    return { state: "paused", detail: "Agent control is paused while a participant controls this tab." };
  }
  if (!model.status.agentControlEnabled && model.status.humanControlReady === false) {
    return { state: "starting", detail: "Waiting for agent operations to stop…" };
  }
  if (!model.status.agentControlEnabled) {
    return { state: "paused", detail: "Agent control is paused." };
  }
  if (model.agentPhase === "unavailable") {
    return {
      state: "unavailable",
      detail: model.agentError ?? "Agent control is unavailable.",
    };
  }
  if (model.agentPhase === "starting" || model.agentPhase === "idle") {
    return { state: "starting", detail: "Starting agent control…" };
  }
  return { state: "ready", detail: "Personal Browser and agent control are ready." };
}

export function PersonalBrowserSurface({
  active,
  compactChrome = false,
  agentWorking = false,
  model,
  transportSelector,
  humanInputIdentityKey,
  onContinueAfterHumanInput,
  sharingControls,
}: {
  active: boolean;
  compactChrome?: boolean;
  agentWorking?: boolean;
  model: PersonalBrowserModel;
  transportSelector: ReactNode;
  humanInputIdentityKey?: string;
  onContinueAfterHumanInput?: (message: string, approvalMode: "ask" | "routine") => Promise<boolean>;
  sharingControls?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastValidBoundsRef = useRef<InstafyDesktopPersonalBrowserBounds>({
    x: 1,
    y: 1,
    width: 1,
    height: 1,
  });
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const [address, setAddress] = useState("");
  const [overlayPreview, setOverlayPreview] = useState<string | null>(null);
  const [overlayCount, setOverlayCount] = useState(0);
  const overlayCountRef = useRef(overlayCount);
  overlayCountRef.current = overlayCount;
  const agentWorkingRef = useRef(agentWorking);
  agentWorkingRef.current = agentWorking;
  const reportBoundsRef = useRef<(() => void) | null>(null);
  const registerOverlay = useCallback(() => {
    setOverlayCount(count => count + 1);
    return () => setOverlayCount(count => count - 1);
  }, []);
  const [fullscreen, setFullscreen] = useState(false);
  const expanded = active && fullscreen;
  const selectedApprovalMode = model.preferredApprovalMode;
  const [dismissedClearDataFeedbackKey, setDismissedClearDataFeedbackKey] =
    useState<string | null>(null);
  const ready = model.status?.state === "ready";
  const visible = active && model.available && ready;
  const ownerId = model.ownerId;
  const routineApprovalAvailable = model.status?.approvalModes?.includes("routine") === true;

  useEffect(() => {
    if (!active) setFullscreen(false);
  }, [active]);

  useEffect(() => {
    if (model.clearDataState === "clearing") {
      setDismissedClearDataFeedbackKey(null);
    }
  }, [model.clearDataState]);

  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) {
      setAddress(model.status?.url ?? "");
    }
  }, [model.status?.url]);

  useLayoutEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.instafyDesktop;
    const viewport = viewportRef.current;
    if (!viewport || !ownerId || typeof bridge?.personalBrowserSetBounds !== "function") {
      return undefined;
    }

    let disposed = false;
    let frame: number | null = null;
    const report = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const rect = viewport.getBoundingClientRect();
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const offsetLeft = window.visualViewport?.offsetLeft ?? 0;
        const offsetTop = window.visualViewport?.offsetTop ?? 0;
        const left = Math.max(rect.left, offsetLeft);
        const top = Math.max(rect.top, offsetTop);
        const right = Math.min(rect.right, offsetLeft + viewportWidth);
        const bottom = Math.min(rect.bottom, offsetTop + viewportHeight);
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        if (width >= 1 && height >= 1) {
          lastValidBoundsRef.current = {
            x: Math.round(left),
            y: Math.round(top),
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
          };
        }
        void bridge.personalBrowserSetBounds?.({
          ...lastValidBoundsRef.current,
          visible: visible && width > 0 && height > 0,
          occluded: overlayCountRef.current > 0,
          agentWorking: agentWorkingRef.current,
          ownerId,
        }).then(result => {
          if (!disposed && overlayCountRef.current > 0 && result.previewDataUrl) setOverlayPreview(result.previewDataUrl);
        }).catch(() => undefined);
      });
    };

    reportBoundsRef.current = report;
    report();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    observer?.observe(viewport);
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    window.visualViewport?.addEventListener("resize", report);
    window.visualViewport?.addEventListener("scroll", report);
    return () => {
      disposed = true;
      reportBoundsRef.current = null;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      window.visualViewport?.removeEventListener("resize", report);
      window.visualViewport?.removeEventListener("scroll", report);
      void bridge.personalBrowserSetBounds?.({
        ...lastValidBoundsRef.current,
        visible: false,
        ownerId,
      }).catch(() => undefined);
    };
  }, [expanded, ownerId, visible]);

  useLayoutEffect(() => {
    if (overlayCount === 0) setOverlayPreview(null);
    reportBoundsRef.current?.();
  }, [overlayCount, agentWorking]);
  useLayoutEffect(() => { setOverlayPreview(null); }, [ownerId]);

  const handleNavigate = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (model.status?.agentControlEnabled || model.status?.tabControlActive) {
        return;
      }
      void model.navigate(address);
      addressInputRef.current?.blur();
    },
    [address, model],
  );

  const handleClearData = useCallback(() => {
    if (!window.confirm(
      "Clear your Personal Browser cookies and site data on this device? This signs you out of websites across all your projects on this device. It does not clear Shared Browser, your Instafy sign-in, or your other browsers. This cannot be undone.",
    )) {
      return;
    }
    void model.clearData();
  }, [model]);

  const browserStatus = personalBrowserStatus(model);
  const humanInputLocked = model.status?.agentControlEnabled === true || model.status?.humanControlReady === false || model.status?.tabControlActive === true;
  const personalHumanInputRequest = model.status?.humanInputRequest;
  const ownsNativeStatus = Boolean(ownerId) && model.status?.ownerId === ownerId;
  const humanInputOptions = {
    identityKey: `${humanInputIdentityKey ?? ""}:${ownerId}`,
    request: ownsNativeStatus && personalHumanInputRequest && personalHumanInputRequest.origin === browserPageOrigin(model.status?.url) ? personalHumanInputRequest : null,
    canTakeOver: active && ownsNativeStatus && model.status?.agentControlEnabled === true && typeof model.status?.humanControlReady === "boolean",
    humanControlConfirmed: ownsNativeStatus && ready && model.status?.humanControlReady === true,
    canContinue: active && ownsNativeStatus && Boolean(onContinueAfterHumanInput),
    takeoverRequestId: ownsNativeStatus ? model.status?.takeoverRequestId : undefined,
    onTakeOver: async () => {
      const status = await model.setAgentControlEnabled(false);
      return status?.agentControlEnabled === false;
    },
    onContinue: async (message: string) => onContinueAfterHumanInput
      ? onContinueAfterHumanInput(message, routineApprovalAvailable ? selectedApprovalMode : "ask")
      : false,
  };
  const humanInputState = useBrowserHumanInput(humanInputOptions);
  const humanInputAvailable = ready && Boolean(humanInputIdentityKey && onContinueAfterHumanInput);
  const clearDataMessage =
    model.clearDataState === "clearing"
      ? "Clearing Personal Browser data…"
      : model.clearDataState === "succeeded"
        ? "Personal Browser data cleared."
        : model.clearDataState === "failed"
          ? model.clearDataError ?? "Personal Browser data could not be cleared."
          : null;
  const clearDataFeedbackKey = clearDataMessage
    ? `${model.clearDataState}:${model.clearDataError ?? ""}`
    : null;
  const clearDataFeedbackDismissible =
    model.clearDataState === "succeeded" || model.clearDataState === "failed";
  const visibleClearDataMessage =
    clearDataFeedbackKey && dismissedClearDataFeedbackKey !== clearDataFeedbackKey
      ? clearDataMessage
      : null;
  const feedbackMessage =
    model.navigationError ?? model.agentError ?? visibleClearDataMessage;
  const feedbackIsError = Boolean(
    model.navigationError || model.agentError || model.clearDataState === "failed",
  );

  const content = (
    <BrowserToolsOverlayContext.Provider value={registerOverlay}>
    <div
      className={active ? "flex h-full min-h-0 flex-1 flex-col" : "hidden"}
      data-testid="personal-browser-surface"
    >
      <BrowserChromeShell
        label="Personal browser controls"
        leading={transportSelector}
        navigation={
          <div className="flex items-center gap-0.5">
          <IconButton
            aria-label="Back"
            className={compactChrome ? "hidden" : "max-[540px]:h-10 max-[540px]:w-10"}
            isDisabled={!ready || humanInputLocked || !model.status?.canGoBack}
            onPress={() => void model.goBack()}
            radius="full"
            size="sm"
            variant="ghost"
          >
            <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label="Forward"
            className={compactChrome ? "hidden" : "max-[540px]:h-10 max-[540px]:w-10"}
            isDisabled={!ready || humanInputLocked || !model.status?.canGoForward}
            onPress={() => void model.goForward()}
            radius="full"
            size="sm"
            variant="ghost"
          >
            <NavArrowRight className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label="Reload"
            className="max-[540px]:h-10 max-[540px]:w-10"
            isDisabled={!ready || humanInputLocked}
            onPress={() => void model.reload()}
            radius="full"
            size="sm"
            variant="ghost"
          >
            <Refresh className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          </div>
        }
        address={
          <form
            className="relative w-full min-w-0"
            data-testid="personal-browser-address-form"
            onSubmit={handleNavigate}
          >
          <label className="sr-only" htmlFor="personal-browser-address">
            Address
          </label>
          <input
            ref={addressInputRef}
            id="personal-browser-address"
            aria-describedby={model.navigationError ? "personal-browser-address-error" : undefined}
            aria-invalid={model.navigationError ? true : undefined}
            aria-label="Address"
            autoCapitalize="none"
            autoComplete="off"
            className="h-8 w-full rounded-full border border-slate-200 bg-white pl-3 pr-9 text-xs text-slate-800 shadow-inner outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20 max-[540px]:h-10 max-[540px]:pr-11 pointer-coarse:h-11 pointer-coarse:pr-12 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-slate-950 dark:text-slate-100"
            data-testid="personal-browser-address"
            disabled={!ready || humanInputLocked}
            onChange={(event) => {
              setAddress(event.target.value);
              model.clearNavigationError();
            }}
            placeholder={
              model.status?.tabControlActive
                ? "Take back control to navigate"
                : humanInputLocked
                ? "Pause agent control to navigate"
                : ready
                ? "Enter an address"
                : model.recovering
                  ? "Reopening Personal Browser…"
                  : model.status?.state === "error"
                    ? "Personal Browser unavailable"
                    : "Opening Personal Browser…"
            }
            spellCheck={false}
            type="text"
            value={address}
          />
          <button
            aria-label="Go"
            className="absolute right-0 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 touch-manipulation items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-40 max-[540px]:h-10 max-[540px]:w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11 dark:text-slate-400 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:hover:text-slate-50"
            data-testid="personal-browser-go"
            disabled={!ready || humanInputLocked}
            title="Go"
            type="submit"
          >
            <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          </form>
        }
        status={
          <BrowserStatusPill
            compact={compactChrome}
            detail={browserStatus.detail}
            state={browserStatus.state}
            testId="personal-browser-agent-status"
          />
        }
        actions={
          <>
          {humanInputAvailable && !model.status?.tabControlActive ? <BrowserHumanInputStatus {...humanInputOptions} state={humanInputState} /> : null}
          {ready && !model.status?.agentControlEnabled && model.agentPhase === "unavailable" && !humanInputState.active ? (
            <IconButton
              aria-label="Retry agent control"
              className="max-[540px]:h-10 max-[540px]:w-10"
              onPress={() => void model.retryAgentControl()}
              radius="full"
              size="sm"
              title="Retry agent control"
              variant="ghost"
            >
              <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          ) : (model.status?.agentControlEnabled && (!humanInputAvailable || humanInputState.active)) || (ready && !model.status?.agentControlEnabled && !humanInputState.active) ? (
            <IconButton
              aria-label={model.status?.agentControlEnabled ? "Pause agent control" : "Resume agent control"}
              isDisabled={!model.status?.agentControlEnabled && (model.status?.humanControlReady === false || model.status?.tabControlActive)}
              className="max-[540px]:h-10 max-[540px]:w-10"
              onPress={() => void model.setAgentControlEnabled(
                !model.status?.agentControlEnabled,
                routineApprovalAvailable ? selectedApprovalMode : undefined,
              )}
              radius="full"
              size="sm"
              title={model.status?.agentControlEnabled ? "Pause agent control" : "Resume agent control"}
              variant="ghost"
            >
              {model.status?.agentControlEnabled ? (
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </IconButton>
          ) : null}
          <BrowserToolsPopover label="Browser settings" trigger={<IconButton aria-label="Browser settings" variant="ghost" radius="full" size="sm"><MoreHoriz className="h-4 w-4" aria-hidden="true" /></IconButton>}>
            {routineApprovalAvailable ? (
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-800" data-browser-session-safe-zone="true">
                <label className="flex min-h-8 cursor-pointer items-center gap-2">
                  <input
                    checked={humanInputLocked ? model.status?.approvalMode === "routine" : selectedApprovalMode === "routine"}
                    className="h-4 w-4"
                    data-testid="personal-browser-routine-approval"
                    disabled={humanInputLocked}
                    onChange={(event) => model.setPreferredApprovalMode(event.target.checked ? "routine" : "ask")}
                    type="checkbox"
                  />
                  Allow routine browsing without asking each time
                </label>
                <span className="text-slate-500 dark:text-slate-400">
                  {model.status?.tabControlActive
                    ? "Take back control before continuing the AI task."
                    : humanInputState.active
                    ? "When ready, choose Let AI continue in the browser toolbar."
                    : humanInputLocked
                    ? "Take over to change approvals."
                    : "Choose before Resume. High-impact actions still ask; secrets stay manual."}
                </span>
              </div>
            ) : null}
          <Button
            aria-label={
              model.clearDataState === "clearing"
                ? "Clearing personal browser data"
                : "Clear personal browser data"
            }
            isDisabled={!ready || model.clearDataState === "clearing"}
            className="w-full justify-start"
            onPress={handleClearData}
            radius="full"
            size="sm"
            title="Clear personal browser data"
            variant="ghost"
          >
            {model.clearDataState === "clearing" ? (
              <Refresh className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Clear personal browser data
          </Button>
          </BrowserToolsPopover>
          {sharingControls}
          <BrowserExpandButton
            expanded={expanded}
            onPress={() => setFullscreen((value) => !value)}
            testId="personal-browser-fullscreen-toggle"
          />
          </>
        }
        feedback={feedbackMessage}
        feedbackId={model.navigationError ? "personal-browser-address-error" : undefined}
        feedbackTestId="personal-browser-feedback"
        feedbackTone={feedbackIsError ? "error" : "success"}
        onDismissFeedback={
          model.navigationError
            ? model.clearNavigationError
            : clearDataFeedbackKey && clearDataFeedbackDismissible
              ? () => setDismissedClearDataFeedbackKey(clearDataFeedbackKey)
              : null
        }
        testId="personal-browser-chrome"
      />
      <div
        ref={viewportRef}
        aria-label="Personal browser content"
        className="relative min-h-0 flex-1 overflow-hidden bg-slate-100 dark:bg-slate-950"
        data-testid="personal-browser-viewport"
      >
        {overlayCount > 0 && overlayPreview ? <img alt="" aria-hidden src={overlayPreview} className="pointer-events-none absolute inset-0 h-full w-full object-fill" data-testid="personal-browser-overlay-preview" /> : null}
        {!ready ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-sm text-sm text-slate-500 dark:text-slate-400">
              <Globe className="mx-auto mb-3 h-8 w-8 text-slate-400" aria-hidden="true" />
              <div className="font-medium text-slate-700 dark:text-slate-200">{browserStatus.detail}</div>
              {model.status?.error ? <div className="mt-1 text-xs text-rose-600 dark:text-rose-300">{model.status.error}</div> : null}
              {model.status?.state === "error" ? (
                <Button
                  className="mt-3"
                  isDisabled={!model.available || model.recovering}
                  onPress={model.retryOpen}
                  radius="full"
                  size="xs"
                  variant="secondary"
                >
                  <Refresh
                    className={`h-3.5 w-3.5 ${model.recovering ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  {model.recovering ? "Retrying…" : "Retry Personal Browser"}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
    </BrowserToolsOverlayContext.Provider>
  );

  if (expanded) {
    return (
      <StudioDialogModal
        isOpen
        onOpenChange={setFullscreen}
        dialogAriaLabel="Personal Browser"
        className="!items-stretch !justify-stretch !p-0"
        modalClassName="!h-dvh !w-screen !max-w-none !overflow-hidden !rounded-none !border-0"
        dialogClassName="h-full pt-[var(--instafy-safe-area-inset-top)] pb-[var(--instafy-safe-area-inset-bottom)] pl-[var(--instafy-safe-area-inset-left)] pr-[var(--instafy-safe-area-inset-right)]"
        data-testid="personal-browser-expanded"
      >
        {content}
      </StudioDialogModal>
    );
  }
  return content;
}
