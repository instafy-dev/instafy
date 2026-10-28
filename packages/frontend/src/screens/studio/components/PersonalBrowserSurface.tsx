import {
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
  Check,
  Globe,
  NavArrowDown,
  NavArrowLeft,
  NavArrowRight,
  Pause,
  Play,
  Refresh,
  Trash,
  MoreHoriz,
  Xmark,
} from "iconoir-react";
import { normalizeBrowserAddress, personalBrowserAddressInput } from "./browserAddress";
import { BrowserAddressField } from "./BrowserAddressField";
import { Checkbox } from "../../../components/Checkbox";
import { Select } from "../../../components/Select";
import { Button, IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { StudioMenuAction, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { BrowserToolsOverlayContext, BrowserToolsPopover } from "./BrowserToolsPopover";
import { BrowserExpandButton } from "./BrowserExpandButton";
import { SendPageToOctoButton } from "./SendPageToOctoButton";
import { BrowserHumanInputStatus } from "./BrowserHumanInputControls";
import { useBrowserHumanInput } from "./useBrowserHumanInput";
import { BrowserReadingRow } from "./BrowserReadingRow";
import { personalBrowserTabPages, resolveAgentReadingPages, shownBrowserPageTitle } from "./browserAgentTabs";
import { browserPageOrigin } from "./browserHandoffRouting";
import {
  BrowserChromeShell,
  BrowserStatusPill,
  type BrowserChromeState,
} from "./BrowserChromeShell";
import { personalBrowserOwnerTier, personalBrowserRoutineAvailable } from "./personalBrowserApprovalPolicy";
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
      <Button variant="ghost" preset="toolbar" className="shrink-0" aria-label={`Browser location: ${location}`} data-testid="browser-location-menu" title={`Runs on ${location.toLowerCase()}`}>
        {mode === "personal" ? <Computer className="h-3.5 w-3.5" aria-hidden="true" /> : <Globe className="h-3.5 w-3.5" aria-hidden="true" />}
        <NavArrowDown className="h-3 w-3" aria-hidden="true" />
      </Button>
    }>
      <Text variant="bodyStrong" tone="primary" className="px-2.5 py-1">Run browser on</Text>
      <div role="group" aria-label="Browser location">
        <StudioMenuAction aria-label="This device" aria-pressed={mode === "personal"}
          aria-describedby={`${descriptionId}-personal`} data-testid="browser-transport-personal"
          isDisabled={!checked || !personalAvailable} onPress={() => choose("personal")}>
          <MenuItemContent start={<Computer aria-hidden="true" />} end={mode === "personal" ? <Check aria-hidden="true" /> : null}
            description={<span id={`${descriptionId}-personal`}>
              {!checked ? "Checking this device… " : !personalAvailable ? "Available in the Instafy desktop app. " : ""}
              Your logins stay on this device and follow you across projects. They are not copied to Shared Browser or your other devices.
            </span>}>
            This device
          </MenuItemContent>
        </StudioMenuAction>
        <StudioMenuAction aria-label="Workspace browser" aria-pressed={mode === "shared"}
          aria-describedby={`${descriptionId}-shared`} data-testid="browser-transport-shared" onPress={() => choose("shared")}>
          <MenuItemContent start={<Globe aria-hidden="true" />} end={mode === "shared" ? <Check aria-hidden="true" /> : null}
            description={<span id={`${descriptionId}-shared`}>Project members see the same remote browser and logged-in pages. Your personal logins are not copied here.</span>}>
            Workspace
          </MenuItemContent>
        </StudioMenuAction>
      </div>
    </BrowserToolsPopover>
  </div>;
}

type PersonalBrowserTab = NonNullable<InstafyDesktopPersonalBrowserStatus["tabs"]>[number];

function tabLabel(tab: PersonalBrowserTab): string {
  const title = shownBrowserPageTitle(tab.title);
  if (title) return title;
  try {
    return new URL(tab.url).host || "New tab";
  } catch {
    return "New tab";
  }
}

/**
 * The open tabs, shown once Octo has opened one of its own. Octo's tabs are
 * marked, so every tab it uses is visible and named as its; the person shows
 * or closes them once Octo is paused.
 */
export function PersonalBrowserTabRow({
  tabs,
  locked,
  onSelect,
  onClose,
}: {
  tabs: readonly PersonalBrowserTab[];
  locked: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  if (tabs.length < 2) return null;
  return (
    <div
      className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-slate-200 px-2 py-1 dark:border-slate-800"
      role="group"
      aria-label="Browser tabs"
      data-testid="personal-browser-tabs"
    >
      {tabs.map((tab) => {
        const label = tabLabel(tab);
        const byOcto = tab.openedBy === "agent";
        return (
          <div
            key={tab.id}
            className={`flex min-w-0 max-w-[14rem] items-center rounded-md ${tab.active ? "bg-slate-200 dark:bg-slate-800" : ""}`}
            data-testid="personal-browser-tab"
            data-active={tab.active ? "true" : "false"}
            data-opened-by={tab.openedBy}
          >
            <Button
              variant="ghost"
              size="xs"
              className="min-w-0 flex-1 justify-start"
              aria-pressed={tab.active}
              aria-label={byOcto ? `${label} (opened by Octo)` : label}
              title={locked && !tab.active ? "Pause Octo to switch tabs" : tab.url}
              isDisabled={locked && !tab.active}
              onPress={() => onSelect(tab.id)}
            >
              {byOcto ? (
                <span className="shrink-0 rounded bg-violet-100 px-1 text-[10px] font-medium text-violet-700 dark:bg-violet-900/50 dark:text-violet-200">
                  Octo
                </span>
              ) : null}
              <span className="min-w-0 truncate">{label}</span>
            </Button>
            {byOcto ? (
              <IconButton
                aria-label={`Close ${label}`}
                size="sm"
                variant="ghost"
                isDisabled={locked}
                onPress={() => onClose(tab.id)}
              >
                <Xmark className="h-3 w-3" aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
  historyUserId,
  onContinueAfterHumanInput,
  onPauseAgentControl,
  onSendPage,
  sendPagePending = false,
  sharingControls,
}: {
  active: boolean;
  compactChrome?: boolean;
  agentWorking?: boolean;
  model: PersonalBrowserModel;
  transportSelector: ReactNode;
  humanInputIdentityKey?: string;
  historyUserId?: string | null;
  onContinueAfterHumanInput?: (message: string, approvalMode: "ask" | "routine") => Promise<boolean>;
  /** The person paused agent control: the toolbar button or any Take over. */
  onPauseAgentControl?: () => void;
  /** Send page to Octo; absent when this person cannot add attachments here. */
  onSendPage?: () => void;
  sendPagePending?: boolean;
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
  const [overlayPreview, setOverlayPreview] = useState<{ identity: string; url: string } | null>(null);
  const boundsRequestRef = useRef(0);
  const [overlayCount, setOverlayCount] = useState(0);
  const overlayCountRef = useRef(overlayCount);
  overlayCountRef.current = overlayCount;
  const overlayEpochRef = useRef({ occluded: false, generation: 0 });
  if (overlayEpochRef.current.occluded !== (overlayCount > 0)) {
    overlayEpochRef.current = { occluded: overlayCount > 0, generation: overlayEpochRef.current.generation + 1 };
  }
  const acceptedPreviewRequestRef = useRef(0);
  const agentWorkingRef = useRef(agentWorking);
  agentWorkingRef.current = agentWorking;
  const reportBoundsRef = useRef<(() => void) | null>(null);
  const registerOverlay = useCallback(() => {
    setOverlayCount(count => count + 1);
    return () => setOverlayCount(count => count - 1);
  }, []);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchEngineFieldId = useId();
  const expanded = active && fullscreen;
  const selectedApprovalMode = model.preferredApprovalMode;
  const [dismissedClearDataFeedbackKey, setDismissedClearDataFeedbackKey] =
    useState<string | null>(null);
  const ready = model.status?.state === "ready";
  const humanInputLocked = model.status?.agentControlEnabled === true || model.status?.humanControlReady === false || model.status?.tabControlActive === true;
  const visible = active && model.available && ready;
  const ownerId = model.ownerId;
  const previewIdentity = JSON.stringify([ownerId, model.status?.ownerId, model.status?.activeTabId, model.status?.url, ready]);
  const previewUrl = overlayPreview?.identity === previewIdentity ? overlayPreview.url : null;
  const routineApprovalAvailable = personalBrowserRoutineAvailable(model.status);
  // On an owner-tier Desktop, "routine" frees reading and links only.
  const ownerTierApproval = personalBrowserOwnerTier(model.status);

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
    const reportNow = () => {
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
      const shown = visible && width > 0 && height > 0;
      const occluded = overlayCountRef.current > 0;
      const overlayGeneration = overlayEpochRef.current.generation;
      const request = ++boundsRequestRef.current;
      void bridge.personalBrowserSetBounds?.({
        ...lastValidBoundsRef.current,
        visible: shown,
        occluded,
        agentWorking: agentWorkingRef.current,
        ownerId,
      }).then(result => {
        if (disposed) return;
        const resultIdentity = JSON.stringify([ownerId, result.ownerId, result.activeTabId, result.url, result.state === "ready"]);
        const sameOverlay = occluded && overlayCountRef.current > 0 && overlayGeneration === overlayEpochRef.current.generation;
        // Native capture happens only when occlusion starts. A later geometry
        // report has no preview and must not invalidate that pending capture.
        if (sameOverlay && request >= acceptedPreviewRequestRef.current && result.previewDataUrl && result.ownerId === ownerId && resultIdentity === previewIdentity) {
          acceptedPreviewRequestRef.current = request;
          setOverlayPreview({ identity: previewIdentity, url: result.previewDataUrl });
        } else if (request === boundsRequestRef.current && shown && !occluded) {
          // Keep the matching menu preview until the native view has been
          // restored. A late hide/capture reply must not replace this frame.
          setOverlayPreview(null);
        }
      }).catch(() => undefined);
    };
    const report = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        reportNow();
      });
    };

    reportBoundsRef.current = reportNow;
    // Visibility is a handoff, not a resize: send it in this layout pass so
    // switching back does not insert an extra hidden native frame.
    reportNow();
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
    };
  }, [expanded, ownerId, visible, previewIdentity]);

  useLayoutEffect(() => {
    const bridge = window.instafyDesktop;
    return () => {
      // Only an owner change or actual unmount needs a separate hide. Effect
      // restarts (including fullscreen) report the new bounds directly.
      if (ownerId) void bridge?.personalBrowserSetBounds?.({
        ...lastValidBoundsRef.current,
        visible: false,
        ownerId,
      }).catch(() => undefined);
    };
  }, [ownerId]);

  useLayoutEffect(() => {
    reportBoundsRef.current?.();
  }, [overlayCount, agentWorking]);
  useLayoutEffect(() => { setOverlayPreview(null); }, [previewIdentity]);

  const navigateToAddress = useCallback(
    (nextAddress: string) => {
      if (!active || !ready || humanInputLocked) {
        return false;
      }
      setAddress(nextAddress);
      model.clearNavigationError();
      void model.navigate(nextAddress);
      // Words that are not an address search with the chosen engine, when the Desktop can.
      const opens = model.searchChoice
        ? personalBrowserAddressInput(nextAddress).kind !== "invalid"
        : Boolean(normalizeBrowserAddress(nextAddress));
      if (!opens) return false;
      addressInputRef.current?.blur();
      return true;
    },
    [active, ready, humanInputLocked, model],
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
      // Every take-over is a Pause: Octo does not reopen the browser by
      // itself afterwards, as after the toolbar's Pause.
      onPauseAgentControl?.();
      const status = await model.setAgentControlEnabled(false);
      return status?.agentControlEnabled === false;
    },
    onContinue: async (message: string) => onContinueAfterHumanInput
      ? onContinueAfterHumanInput(message, routineApprovalAvailable ? selectedApprovalMode : "ask")
      : false,
  };
  const humanInputState = useBrowserHumanInput(humanInputOptions);
  const humanInputAvailable = ready && Boolean(humanInputIdentityKey && onContinueAfterHumanInput);
  // Whenever the agent holds control of this browser, the pages it is
  // reading: the tabs it opened and the tab on screen, which is the one it
  // controls. That is the case with or without a turn of this conversation
  // working, since another conversation's turn, or a resumed browser between
  // turns, holds it too. Take over is the same action as the toolbar's: Pause
  // revokes the broker, so it ends the agent's control of every tab at once.
  const personalPages = personalBrowserTabPages(ownsNativeStatus ? model.status : null);
  const agentReadingPages = resolveAgentReadingPages({
    pages: personalPages,
    agentControlActive: ready && ownsNativeStatus &&
      model.status?.agentControlEnabled === true && !model.status?.tabControlActive,
    agentPageIds: personalPages.filter((page) => page.isActive).map((page) => page.id),
  });
  const resumeFromStatus = ready && browserStatus.state === "paused" &&
    !model.status?.agentControlEnabled && model.agentPhase !== "unavailable" && !humanInputState.active;
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
          <div className="flex items-center gap-2">
          {!compactChrome ? (<>
            <IconButton
              aria-label="Back"
              isDisabled={!ready || humanInputLocked || !model.status?.canGoBack}
              onPress={() => void model.goBack()}
              size="sm"
              variant="ghost"
            >
              <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              aria-label="Forward"
              isDisabled={!ready || humanInputLocked || !model.status?.canGoForward}
              onPress={() => void model.goForward()}
              size="sm"
              variant="ghost"
            >
              <NavArrowRight className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </>) : null}
          <IconButton
            aria-label="Reload"
            isDisabled={!ready || humanInputLocked}
            onPress={() => void model.reload()}
            size="sm"
            variant="ghost"
          >
            <Refresh className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          </div>
        }
        address={
          <BrowserAddressField
            ref={addressInputRef}
            testIdPrefix="personal-browser"
            errorId={model.navigationError ? "personal-browser-address-error" : undefined}
            invalid={Boolean(model.navigationError)}
            disabled={!active || !ready || humanInputLocked}
            value={address}
            historyUserId={historyUserId}
            currentPage={active && ready && ownsNativeStatus && model.status ? {
              url: model.status.url,
              title: model.status.title,
            } : null}
            onNavigate={navigateToAddress}
            errorMessage={model.navigationError}
            onValueChange={(value) => {
              setAddress(value);
              model.clearNavigationError();
            }}
            placeholder={
              model.status?.tabControlActive
                ? "Take back control to navigate"
                : humanInputLocked
                ? "Pause agent control to navigate"
                : ready
                ? model.searchChoice ? "Search or enter an address" : "Enter an address"
                : model.recovering
                  ? "Reopening Personal Browser…"
                  : model.status?.state === "error"
                    ? "Personal Browser unavailable"
                    : "Opening Personal Browser…"
            }
          />
        }
        status={
          <BrowserStatusPill
            compact={compactChrome}
            detail={browserStatus.detail}
            state={browserStatus.state}
            testId="personal-browser-agent-status"
            resume={resumeFromStatus ? {
              disabled: model.status?.humanControlReady === false || model.status?.tabControlActive,
              onPress: () => void model.setAgentControlEnabled(true, routineApprovalAvailable ? selectedApprovalMode : undefined),
            } : undefined}
          />
        }
        actions={
          <>
          {humanInputAvailable && !model.status?.tabControlActive ? <BrowserHumanInputStatus {...humanInputOptions} state={humanInputState} /> : null}
          {ready && !model.status?.agentControlEnabled && model.agentPhase === "unavailable" && !humanInputState.active ? (
            <IconButton
              aria-label="Retry agent control"
              onPress={() => void model.retryAgentControl()}
              size="sm"
              title="Retry agent control"
              variant="ghost"
            >
              <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          ) : !resumeFromStatus && ((model.status?.agentControlEnabled && (!humanInputAvailable || humanInputState.active)) || (ready && !model.status?.agentControlEnabled && !humanInputState.active)) ? (
            <IconButton
              aria-label={model.status?.agentControlEnabled ? "Pause agent control" : "Resume agent control"}
              isDisabled={!model.status?.agentControlEnabled && (model.status?.humanControlReady === false || model.status?.tabControlActive)}
              onPress={() => {
                if (model.status?.agentControlEnabled) onPauseAgentControl?.();
                void model.setAgentControlEnabled(
                  !model.status?.agentControlEnabled,
                  routineApprovalAvailable ? selectedApprovalMode : undefined,
                );
              }}
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
          {onSendPage ? (
            <SendPageToOctoButton
              onPress={onSendPage}
              pending={sendPagePending}
              disabled={!active || !ready || !ownsNativeStatus || !/^https?:\/\//i.test(model.status?.url ?? "")}
            />
          ) : null}
          <BrowserToolsPopover label="Browser settings" isOpen={settingsOpen} onOpenChange={setSettingsOpen} trigger={<IconButton aria-label="Browser settings" variant="ghost" size="sm"><MoreHoriz className="h-4 w-4" aria-hidden="true" /></IconButton>}>
            {compactChrome ? (
              <div role="group" aria-label="Page history">
                <StudioMenuAction
                  isDisabled={!ready || humanInputLocked || !model.status?.canGoBack}
                  onPress={() => { setSettingsOpen(false); void model.goBack(); }}
                >
                  <MenuItemContent start={<NavArrowLeft aria-hidden="true" />}>Back</MenuItemContent>
                </StudioMenuAction>
                <StudioMenuAction
                  isDisabled={!ready || humanInputLocked || !model.status?.canGoForward}
                  onPress={() => { setSettingsOpen(false); void model.goForward(); }}
                >
                  <MenuItemContent start={<NavArrowRight aria-hidden="true" />}>Forward</MenuItemContent>
                </StudioMenuAction>
              </div>
            ) : null}
            {routineApprovalAvailable ? (
              <div className="space-y-1 px-2.5 py-1" data-browser-session-safe-zone="true">
                <Checkbox
                  label={ownerTierApproval
                    ? "Let Octo browse and read without asking for each site"
                    : "Allow routine browsing without asking each time"}
                  isSelected={humanInputLocked ? model.status?.approvalMode === "routine" : selectedApprovalMode === "routine"}
                  data-testid="personal-browser-routine-approval"
                  isDisabled={humanInputLocked}
                  onChange={(checked) => model.setPreferredApprovalMode(checked ? "routine" : "ask")}
                />
                <Text variant="caption" tone="muted">
                  {model.status?.tabControlActive
                    ? "Take back control before continuing the AI task."
                    : humanInputState.active
                    ? "When ready, choose Let AI continue in the browser toolbar."
                    : humanInputLocked
                    ? "Take over to change approvals."
                    : ownerTierApproval
                    ? "Choose before Resume. Forms, buttons and messages still ask; secrets stay manual."
                    : "Choose before Resume. High-impact actions still ask; secrets stay manual."}
                </Text>
              </div>
            ) : null}
          {model.searchChoice ? (
            <div className="flex items-center gap-2 px-2.5 py-1">
              <Text as="label" htmlFor={searchEngineFieldId} variant="caption" tone="muted" className="shrink-0">Search with</Text>
              <Select
                id={searchEngineFieldId}
                size="sm"
                value={model.searchChoice.selected ?? ""}
                data-testid="personal-browser-search-engine"
                onChange={(event) => void model.setSearchEngine(event.target.value)}
              >
                {model.searchChoice.engines.map((engine) => (
                  <option key={engine.id} value={engine.id}>{engine.name}</option>
                ))}
              </Select>
            </div>
          ) : null}
          <StudioMenuSeparator />
          <StudioMenuAction
            aria-label={
              model.clearDataState === "clearing"
                ? "Clearing personal browser data"
                : "Clear personal browser data"
            }
            isDisabled={!ready || model.clearDataState === "clearing"}
            onPress={handleClearData}
          >
            <MenuItemContent start={model.clearDataState === "clearing" ? (
              <Refresh className="animate-spin" aria-hidden="true" />
            ) : (
              <Trash aria-hidden="true" />
            )}>
            Clear personal browser data
            </MenuItemContent>
          </StudioMenuAction>
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
      <PersonalBrowserTabRow
        tabs={ready && ownsNativeStatus ? model.status?.tabs ?? [] : []}
        locked={humanInputLocked}
        onSelect={(tabId) => void model.selectTab(tabId)}
        onClose={(tabId) => void model.closeTab(tabId)}
      />
      <BrowserReadingRow
        pages={agentReadingPages}
        canTakeOver={humanInputOptions.canTakeOver && (!humanInputState.active || humanInputState.busy === "takeover")}
        takingOver={humanInputState.busy === "takeover"}
        // The toolbar's take-over controls already say why a take-over failed.
        error={humanInputAvailable ? null : humanInputState.error}
        onTakeOver={() => void humanInputState.takeOver()}
      />
      <div
        ref={viewportRef}
        aria-label="Personal browser content"
        className="relative min-h-0 flex-1 overflow-hidden bg-slate-100 dark:bg-slate-950"
        data-testid="personal-browser-viewport"
      >
        {visible && previewUrl ? <img alt="" aria-hidden src={previewUrl} className="pointer-events-none absolute inset-0 h-full w-full object-fill" data-testid="personal-browser-overlay-preview" /> : null}
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
