import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Play, Refresh, Xmark } from "iconoir-react";
import type { RuntimeMenuOption } from "../useRuntimeMenu";
import { hostedMachineOwnName } from "../runtimeLabels";
import { RuntimeMenuOptionsList } from "./RuntimeMenuOptionsList";
import type { TunnelCopyMode } from "./RuntimeTunnelDetails";
import {
  isHostedRuntimeBlockerSpaceError,
  parseHostedRuntimeLimitError,
  type HostedRuntimeLimitErrorDetails,
} from "../hostedRuntimeLimitError";
import {
  buildStudioDestinationSearch,
  type StudioDestination,
} from "../../navigation/studioNavigation";
import { useStudioNavigation } from "../../navigation/useStudioNavigation";
import { Button, IconButton } from "../../components/Button";
import { InlineNotice } from "../../components/InlineNotice";
import { Text } from "../../components/Text";

/** Instafy's hosted machine: the provider the hosted start asks for. */
function isHostedMachineOption(option: RuntimeMenuOption): boolean {
  const provider = (option.provider ?? "").trim().toLowerCase();
  return provider === "instafy-cloud" || provider === "instafy_cloud";
}

/**
 * The controller's refusal when this server has no hosted provider
 * (`provider '…' is not configured on this controller`). It is the server's
 * setup, the same for every space on it, so another try fails the same way
 * until whoever runs the server changes it. hostedBrowserViewState reads the
 * browser's own request the same way.
 */
const HOSTED_PROVIDER_NOT_CONFIGURED = /provider\s+['"][^'"]+['"]\s+is not configured/i;

/**
 * Studio destination for the blocking space's Machines panel. A panel
 * destination keeps the current space, so the switch is written as a full
 * route: project plus panel in one URL, the way a restored visit is.
 */
export function blockerSpaceMachinesDestination(projectId: string): StudioDestination {
  const search = buildStudioDestinationSearch(
    `?${new URLSearchParams({ projectId }).toString()}`,
    { kind: "panel", panel: "machines" },
  );
  return { kind: "route", search };
}

/**
 * Switches to the blocking space's Machines panel through Studio navigation,
 * so the URL changes and any open drawer or sidebar closes first. Lives in
 * the panel's own tree so no host has to thread a project switch through.
 */
function OpenBlockerSpaceButton({ projectId }: { projectId: string }) {
  const navigateToDestination = useStudioNavigation();
  return (
    <Button
      onPress={() => navigateToDestination(blockerSpaceMachinesDestination(projectId))}
      variant="text"
      tone="accent"
      preset="inline"
      className="mt-1"
      data-testid="runtime-open-blocker-space"
    >
      Open space
    </Button>
  );
}

interface RuntimeMenuPanelProps {
  runtimeEnsureError: string | null;
  runtimeEnsureLimit?: HostedRuntimeLimitErrorDetails | null;
  connectionWarning: string | null;
  title?: string;
  showHeader?: boolean;
  onClose?: () => void;
  onRetryHosted?: () => void | Promise<boolean>;
  hostedRuntimeEnsuring?: boolean;
  onTakeOverHostedRuntimeLimit?: () => void | Promise<boolean>;
  hostedRuntimeTakeoverInProgress?: boolean;
  runtimeOptions: RuntimeMenuOption[];
  selectedRuntimeId: string | null;
  onSelectOption: (runtimeId: string | null) => void;
  /**
   * Before the space's chosen machine, above the list. It is the machine a
   * row calls "Selected machine" (pinning is an agent's, on the Machines page).
   */
  selectionPinnedPrefix?: string;
  onTerminateRuntime?: (runtimeId: string | null) => void;
  onRemoveRuntime?: (runtimeId: string | null) => void;
  onStartRuntime?: (runtimeId: string | null) => void;
  onShowSelfHostHelp?: () => void;
  onCopyTunnel?: (mode: TunnelCopyMode, runtimeId?: string | null) => void;
  listClassName?: string;
  emptyStateMessage?: string;
  /**
   * What a machine is for, under the empty message (page-style hosts). The
   * panel adds what starts a hosted machine only while it offers to start one.
   */
  emptyStateDetail?: string;
  /** Option whose details start expanded (page-style hosts). */
  defaultExpandedOptionId?: string | null;
  /** Extra host content rendered inside an option's expanded details. */
  renderOptionExtras?: (option: RuntimeMenuOption) => ReactNode;
  /** Trend size: compact mini-sparklines (menus) or full-row plots (pages). */
  sparklineVariant?: "compact" | "page";
  /** Lifecycle controls as header icon buttons (page-style hosts). */
  headerActions?: boolean;
  interactionMode?: "picker" | "manage";
}

export function RuntimeMenuPanel({
  runtimeEnsureError,
  runtimeEnsureLimit = null,
  connectionWarning,
  title = "Machines",
  showHeader = true,
  onClose,
  onRetryHosted,
  hostedRuntimeEnsuring = false,
  onTakeOverHostedRuntimeLimit,
  hostedRuntimeTakeoverInProgress = false,
  runtimeOptions,
  selectedRuntimeId,
  onSelectOption,
  selectionPinnedPrefix = "Selected machine:",
  onTerminateRuntime,
  onRemoveRuntime,
  onStartRuntime,
  onShowSelfHostHelp,
  onCopyTunnel,
  listClassName = "mt-2 max-h-60 overflow-auto",
  emptyStateMessage = "No machine is connected to this space yet.",
  emptyStateDetail,
  defaultExpandedOptionId = null,
  renderOptionExtras,
  sparklineVariant = "compact",
  headerActions = false,
  interactionMode = "picker",
}: RuntimeMenuPanelProps) {
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [cachedRuntimeEnsureError, setCachedRuntimeEnsureError] = useState<string | null>(null);
  const [cachedRuntimeEnsureLimit, setCachedRuntimeEnsureLimit] =
    useState<HostedRuntimeLimitErrorDetails | null>(null);
  const [runtimeActionError, setRuntimeActionError] = useState<string | null>(null);
  // Kept apart from runtimeActionError: that one is reset whenever the ensure
  // error changes, and the retried ensure behind a takeover changes it.
  const [blockerSpaceNotice, setBlockerSpaceNotice] = useState<{
    message: string;
    projectId: string | null;
  } | null>(null);
  const [retryingHostedLocally, setRetryingHostedLocally] = useState(false);
  useEffect(() => {
    if (!hostedRuntimeEnsuring) {
      setRetryingHostedLocally(false);
    }
  }, [hostedRuntimeEnsuring]);
  useEffect(() => {
    setRuntimeActionError(null);
  }, [runtimeEnsureError]);
  const retryHostedPending = hostedRuntimeEnsuring || retryingHostedLocally;
  useEffect(() => {
    if (runtimeEnsureError) {
      setCachedRuntimeEnsureError(runtimeEnsureError);
      setCachedRuntimeEnsureLimit(runtimeEnsureLimit);
      return;
    }
    if (!retryHostedPending) {
      setCachedRuntimeEnsureError(null);
      setCachedRuntimeEnsureLimit(null);
    }
  }, [retryHostedPending, runtimeEnsureError, runtimeEnsureLimit]);
  const displayedRuntimeEnsureError =
    runtimeEnsureError ?? (retryHostedPending ? cachedRuntimeEnsureError : null);
  const displayedRuntimeEnsureLimit = runtimeEnsureError
    ? runtimeEnsureLimit
    : retryHostedPending
      ? cachedRuntimeEnsureLimit
      : null;
  const displayedRuntimeOptions = useMemo<RuntimeMenuOption[]>(() => {
    if (!retryHostedPending) {
      return runtimeOptions;
    }
    return runtimeOptions.map((option) => {
      if (!isHostedMachineOption(option) || option.state === "online" || option.state === "idle" || option.state === "booting") {
        return option;
      }
      return {
        ...option,
        state: "booting" as const,
        badge: option.badge ?? { text: "Starting", tone: "warning" },
      };
    });
  }, [retryHostedPending, runtimeOptions]);
  const limitDetails = parseHostedRuntimeLimitError(
    displayedRuntimeEnsureError,
    displayedRuntimeEnsureLimit,
  );
  const limitReached = limitDetails.limitReached;
  // Display is gated on `limitReached` below; this only drops the stale
  // notice once the limit lifts, so a later limit does not resurface a
  // message about a blocker that is gone.
  useEffect(() => {
    if (!limitReached) {
      setBlockerSpaceNotice(null);
    }
  }, [limitReached]);
  const hasTakeoverBlocker = Boolean(limitDetails.blockerRuntimeId);
  const blockerProjectLabel =
    limitDetails.blockerProjectLabel ?? limitDetails.blockerProjectId;
  // The blocker is a hosted machine. Only a name of its own gets a line: the
  // generic one (the stored "Hosted Runtime", or no name) would only repeat
  // the summary, which already names the blocker's space.
  const blockerMachineName = hostedMachineOwnName(limitDetails.blockerRuntimeLabel);
  // The limit is the team's (the controller counts the organization's hosted
  // machines), so a personal space reads it as its Personal team's.
  const runtimeSlotSummary =
    typeof limitDetails.activeCount === "number" &&
    typeof limitDetails.maxActiveCount === "number"
      ? `${limitDetails.activeCount}/${limitDetails.maxActiveCount} hosted machines for this team are in use.`
      : "All hosted machines for this team are in use.";
  // A refusal before launch (a limit, capacity, credits) leaves no hosted
  // machine in the space, so the retry names one only when the list shows it.
  const showsHostedMachine = displayedRuntimeOptions.some(isHostedMachineOption);
  // A server without the hosted provider refuses every try the same way: the
  // warning says who can change that and offers no retry.
  const hostedProviderMissing =
    !limitReached && HOSTED_PROVIDER_NOT_CONFIGURED.test(displayedRuntimeEnsureError ?? "");
  const offersHostedRetry = Boolean(onRetryHosted) && !hostedProviderMissing;
  const errorHeadline = limitReached
    ? "Hosted machine limit reached"
    : "Instafy couldn't start a hosted machine";
  const errorSummary = limitReached
    ? blockerProjectLabel
      ? `${runtimeSlotSummary} The blocking machine is in the space "${blockerProjectLabel}".`
      : runtimeSlotSummary
    : hostedProviderMissing
      ? "This server isn't set up to start hosted machines. Ask whoever runs this Instafy server to set it up."
      : offersHostedRetry
        ? showsHostedMachine
          ? "Reconnect to try again, or view details to see the error."
          : "Try again, or view details to see the error."
        : "View details to see the error.";
  const pinnedRuntimeLabel = selectedRuntimeId
    ? displayedRuntimeOptions.find((option) => option.id === selectedRuntimeId)?.label ??
      selectedRuntimeId
    : null;
  const primaryRestartOption = useMemo(() => {
    if (
      displayedRuntimeEnsureError ||
      displayedRuntimeOptions.some((option) => option.state !== "offline")
    ) {
      return null;
    }
    const restartableOptions = displayedRuntimeOptions.filter(
      (option) => Boolean(option.id) && !option.isLikelyLocal && option.state === "offline",
    );
    return (
      restartableOptions.find((option) => option.id === selectedRuntimeId) ??
      restartableOptions[0] ??
      null
    );
  }, [displayedRuntimeEnsureError, displayedRuntimeOptions, selectedRuntimeId]);
  const handleTakeOverHostedRuntimeLimit = async () => {
    if (!onTakeOverHostedRuntimeLimit) {
      return;
    }
    setRuntimeActionError(null);
    setBlockerSpaceNotice(null);
    try {
      const result = await onTakeOverHostedRuntimeLimit();
      if (result === false) {
        setRuntimeActionError(
          "A hosted machine didn't start for this space yet. View details, or try again in a moment.",
        );
      }
    } catch (error) {
      if (isHostedRuntimeBlockerSpaceError(error)) {
        setBlockerSpaceNotice({
          message: error.message,
          projectId: error.blockerProjectId ?? limitDetails.blockerProjectId,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeActionError(`Couldn't stop the blocking machine: ${message}`);
    }
  };
  const handleRetryHosted = async () => {
    setRuntimeActionError(null);
    setBlockerSpaceNotice(null);
    setRetryingHostedLocally(true);
    try {
      const result = await onRetryHosted?.();
      if (result === false) {
        setRuntimeActionError(
          limitReached
            ? "All hosted machines for this team are still in use. Stop one you no longer need, then try again."
            : "The hosted machine still didn't start. View details, or try again.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeActionError(`Couldn't start a hosted machine: ${message}`);
    } finally {
      setRetryingHostedLocally(false);
    }
  };
  const managesMachines = interactionMode === "manage";
  // The panel offers to start a hosted machine only with a handler for it and
  // while no failure is shown; the warning above then offers its own retry.
  const offersHostedStart = !displayedRuntimeEnsureError && Boolean(onRetryHosted);
  // The control pressed here waits with isPending, which keeps keyboard focus
  // on it (Button.tsx). A takeover, or a start asked for anywhere else,
  // disables it instead.
  const hostedStartBlocked =
    !retryingHostedLocally && (hostedRuntimeTakeoverInProgress || hostedRuntimeEnsuring);
  // Said only beside that offer, so a host without hosted machines never names them.
  const emptyStateDetailText = [
    emptyStateDetail,
    offersHostedStart
      ? "Instafy starts a hosted machine for this space when you message an agent."
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <Text as="div" variant="bodyStrong" tone="primary">
            {title}
          </Text>
          {onClose ? (
            <IconButton
              variant="ghost"
              size="sm"
              onPress={onClose}
              aria-label="Close machine menu"
              tone="neutral"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      {displayedRuntimeEnsureError ? (
        <InlineNotice tone="warning" density="comfortable" className="mt-2">
          <div>
            <Text as="p" variant="bodyStrong" tone="primary">
              {errorHeadline}
            </Text>
            <Text as="p" variant="bodyCompact" tone="secondary">
              {errorSummary}
            </Text>
            {limitReached ? (
              <>
                {blockerProjectLabel && blockerMachineName ? (
                  <Text as="p" variant="bodyCompact" tone="secondary" className="mt-1">
                    Blocking machine: {blockerMachineName}.
                  </Text>
                ) : null}
                <Text as="p" variant="bodyCompact" tone="secondary" className="mt-1">
                  Stop a hosted machine you no longer need, then try again. Stopping the blocking machine can interrupt work on it.
                </Text>
              </>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                onPress={() => setShowErrorDetails((current) => !current)}
                variant="text"
                tone="neutral"
                preset="inline"
              >
                {showErrorDetails ? "Hide details" : "View details"}
              </Button>
              {limitReached && hasTakeoverBlocker && onTakeOverHostedRuntimeLimit ? (
                <Button
                  onPress={handleTakeOverHostedRuntimeLimit}
                  variant="text"
                  tone="danger"
                  preset="inline"
                  isDisabled={hostedRuntimeTakeoverInProgress}
                >
                  {hostedRuntimeTakeoverInProgress
                    ? "Stopping blocker..."
                    : "Stop blocker and retry"}
                </Button>
              ) : null}
            </div>
            {displayedRuntimeEnsureError && showErrorDetails ? (
              <Text
                as="pre"
                variant="mono"
                tone="inherit"
                className="mt-2 overflow-x-auto whitespace-pre-wrap break-words"
              >
                {displayedRuntimeEnsureError}
              </Text>
            ) : null}
            {offersHostedRetry ? (
              <Button
                onPress={handleRetryHosted}
                variant="primary"
                preset="inline"
                icon={<Refresh className="h-3.5 w-3.5" aria-hidden="true" />}
                isPending={retryingHostedLocally}
                isDisabled={hostedStartBlocked}
                fullWidth
                className="mt-3"
                data-testid="runtime-reconnect-cloud"
              >
                {showsHostedMachine
                  ? retryHostedPending
                    ? "Reconnecting the hosted machine…"
                    : "Reconnect the hosted machine"
                  : retryHostedPending
                    ? "Starting a hosted machine…"
                    : "Try again"}
              </Button>
            ) : null}
            {hostedProviderMissing && onShowSelfHostHelp ? (
              // In place of a retry that would fail the same way: the host's
              // dialog for connecting a machine of one's own.
              <Button
                onPress={() => onShowSelfHostHelp()}
                variant="secondary"
                preset="inline"
                className="mt-3"
                data-testid="runtime-connect-own-machine"
              >
                Connect your own machine
              </Button>
            ) : null}
            {runtimeActionError ? (
              <Text
                as="p"
                variant="bodyCompact"
                tone="danger"
                role="alert"
                className="mt-2"
                data-testid="runtime-action-error"
              >
                {runtimeActionError}
              </Text>
            ) : null}
            {limitReached && blockerSpaceNotice ? (
              <Text
                as="div"
                variant="bodyCompact"
                tone="danger"
                role="alert"
                className="mt-2"
                data-testid="runtime-blocker-space-notice"
              >
                <Text as="p" variant="bodyCompact" tone="inherit">
                  {blockerSpaceNotice.message}
                </Text>
                {blockerSpaceNotice.projectId ? (
                  <OpenBlockerSpaceButton projectId={blockerSpaceNotice.projectId} />
                ) : null}
              </Text>
            ) : null}
          </div>
        </InlineNotice>
      ) : null}
      {connectionWarning ? (
        <InlineNotice
          tone="warning"
          density="comfortable"
          className="mt-2"
          data-testid="runtime-connection-warning"
        >
          <div>
            <Text as="p" variant="bodyStrong" tone="primary">
              Machine status may be out of date
            </Text>
            <Text as="p" variant="bodyCompact" tone="secondary">
              {connectionWarning}
            </Text>
          </div>
        </InlineNotice>
      ) : null}
      {pinnedRuntimeLabel ? (
        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <Text as="div" variant="caption" tone="muted" className="min-w-0 truncate">
            {selectionPinnedPrefix} {pinnedRuntimeLabel}
          </Text>
          <Button
            onPress={() => onSelectOption(null)}
            variant="text"
            tone="neutral"
            preset="inline"
            className="shrink-0"
          >
            Use best available
          </Button>
        </div>
      ) : null}
      {primaryRestartOption && onStartRuntime ? (
        // The Machines page keeps Start in the shared neutral tone, at the
        // width of its label (docs/Settings-UI.md); the menu keeps its bar.
        <Button
          onPress={() => onStartRuntime(primaryRestartOption.id)}
          variant={managesMachines ? "secondary" : "primary"}
          preset="inline"
          fullWidth={!managesMachines}
          className="mt-3"
          data-testid="runtime-start-existing"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          Start {primaryRestartOption.label}
        </Button>
      ) : null}
      {displayedRuntimeOptions.length > 0 ? (
        <RuntimeMenuOptionsList
          options={displayedRuntimeOptions}
          selectedRuntimeId={selectedRuntimeId}
          onSelectOption={onSelectOption}
          onTerminateRuntime={onTerminateRuntime}
          onRemoveRuntime={onRemoveRuntime}
          onStartRuntime={onStartRuntime}
          onShowSelfHostHelp={onShowSelfHostHelp}
          className={listClassName}
          selectedOptionClassName="bg-slate-100 text-slate-900 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-50"
          emptyStateMessage={emptyStateMessage}
          onCopyTunnel={onCopyTunnel}
          copyDisabled={false}
          defaultExpandedOptionId={defaultExpandedOptionId}
          renderOptionExtras={renderOptionExtras}
          sparklineVariant={sparklineVariant}
          headerActions={headerActions}
          interactionMode={interactionMode}
        />
      ) : managesMachines ? (
        // Plain page content, flush with the page heading: what a machine is
        // for, what starts one, and a neutral Start sized to its label.
        <div className="mt-2">
          <Text as="p" variant="bodyStrong" tone="primary">
            {emptyStateMessage}
          </Text>
          {emptyStateDetailText ? (
            <Text as="p" variant="bodyCompact" tone="secondary" className="mt-1">
              {emptyStateDetailText}
            </Text>
          ) : null}
          {offersHostedStart ? (
            <Button
              onPress={handleRetryHosted}
              variant="secondary"
              preset="inline"
              icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
              isPending={retryingHostedLocally}
              isDisabled={hostedStartBlocked}
              className="mt-3"
              data-testid="runtime-start-cloud"
            >
              {retryHostedPending ? "Starting a hosted machine…" : "Start one now"}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 px-2.5 py-3">
          <Text as="p" variant="bodyCompact" tone="secondary">
            {emptyStateMessage}
          </Text>
          {offersHostedStart ? (
            <Button
              onPress={handleRetryHosted}
              variant="primary"
              preset="inline"
              icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
              isPending={retryingHostedLocally}
              isDisabled={hostedStartBlocked}
              fullWidth
              className="mt-3"
              data-testid="runtime-start-cloud"
            >
              {retryHostedPending ? "Starting a hosted machine…" : "Start a hosted machine"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
