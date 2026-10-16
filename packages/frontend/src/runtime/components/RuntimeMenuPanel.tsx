import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Play, Refresh, Xmark } from "iconoir-react";
import type { RuntimeMenuOption } from "../useRuntimeMenu";
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
import { Spinner } from "../../components/Spinner";
import { Text } from "../../components/Text";

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
      size="xs"
      radius="full"
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
  selectionPinnedPrefix?: string;
  onTerminateRuntime?: (runtimeId: string | null) => void;
  onRemoveRuntime?: (runtimeId: string | null) => void;
  onStartRuntime?: (runtimeId: string | null) => void;
  onShowSelfHostHelp?: () => void;
  onCopyTunnel?: (mode: TunnelCopyMode, runtimeId?: string | null) => void;
  listClassName?: string;
  emptyStateMessage?: string;
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
  title = "Runtimes",
  showHeader = true,
  onClose,
  onRetryHosted,
  hostedRuntimeEnsuring = false,
  onTakeOverHostedRuntimeLimit,
  hostedRuntimeTakeoverInProgress = false,
  runtimeOptions,
  selectedRuntimeId,
  onSelectOption,
  selectionPinnedPrefix = "Pinned to",
  onTerminateRuntime,
  onRemoveRuntime,
  onStartRuntime,
  onShowSelfHostHelp,
  onCopyTunnel,
  listClassName = "mt-2 max-h-60 overflow-auto",
  emptyStateMessage = "No runtimes available yet.",
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
      const provider = (option.provider ?? "").trim().toLowerCase();
      const isHostedCloud = provider === "instafy-cloud" || provider === "instafy_cloud";
      if (!isHostedCloud || option.state === "online" || option.state === "idle" || option.state === "booting") {
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
  const blockerRuntimeLabel =
    limitDetails.blockerRuntimeLabel ?? limitDetails.blockerRuntimeId;
  const runtimeSlotSummary =
    typeof limitDetails.activeCount === "number" &&
    typeof limitDetails.maxActiveCount === "number"
      ? `${limitDetails.activeCount}/${limitDetails.maxActiveCount} Instafy Cloud runtimes are in use.`
      : "All Instafy Cloud runtime slots are in use.";
  const errorHeadline = limitReached
    ? "Instafy Cloud runtime limit reached"
    : "Instafy Cloud could not start the hosted runtime";
  const errorSummary = limitReached
    ? blockerProjectLabel
      ? `${runtimeSlotSummary} The blocker is in space "${blockerProjectLabel}".`
      : runtimeSlotSummary
    : "Retry to request another hosted runtime. Open details if you need the provider error.";
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
          "Runtime takeover did not complete. Open details or retry after cleanup.",
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
      setRuntimeActionError(`Unable to take over runtime: ${message}`);
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
            ? "Runtime is still at limit. Stop a stale runtime or retry after cleanup."
            : "Runtime retry did not complete. Open details or try again.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeActionError(`Unable to retry runtime: ${message}`);
    } finally {
      setRetryingHostedLocally(false);
    }
  };

  return (
    <div>
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <Text as="div" variant="captionStrong" tone="secondary">
            {title}
          </Text>
          {onClose ? (
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              onPress={onClose}
              aria-label="Close runtimes menu"
              tone="muted"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      {displayedRuntimeEnsureError ? (
        <InlineNotice tone="warning" className="mt-2">
          <div>
            <Text as="p" variant="captionStrong" tone="inherit">
              {errorHeadline}
            </Text>
            <Text as="p" variant="caption" tone="inherit">
              {errorSummary}
            </Text>
            {limitReached ? (
              <>
                {blockerProjectLabel ? (
                  <Text as="p" variant="caption" tone="inherit" className="mt-1">
                    Blocking runtime: {blockerRuntimeLabel ?? "active runtime"}.
                  </Text>
                ) : null}
                <Text as="p" variant="caption" tone="inherit" className="mt-1">
                  Stop a stale runtime or retry after cleanup. Stopping a blocker can interrupt work on that runtime.
                </Text>
              </>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                onPress={() => setShowErrorDetails((current) => !current)}
                variant="text"
                tone="accent"
                size="xs"
                radius="full"
              >
                {showErrorDetails ? "Hide details" : "View details"}
              </Button>
              {limitReached && hasTakeoverBlocker && onTakeOverHostedRuntimeLimit ? (
                <Button
                  onPress={handleTakeOverHostedRuntimeLimit}
                  variant="text"
                  tone="danger"
                  size="xs"
                  radius="full"
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
            {onRetryHosted ? (
              <Button
                onPress={handleRetryHosted}
                variant="primary"
                size="sm"
                isDisabled={hostedRuntimeTakeoverInProgress || retryHostedPending}
                radius="xl"
                fullWidth
                className="mt-3"
                data-testid="runtime-reconnect-cloud"
              >
                {retryHostedPending ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner
                      tone="slate"
                      size="xs"
                      className="border-white/40 border-t-white"
                      aria-hidden="true"
                    />
                    Reconnecting Instafy Cloud…
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
                    Reconnect Instafy Cloud
                  </span>
                )}
              </Button>
            ) : null}
            {runtimeActionError ? (
              <Text
                as="p"
                variant="caption"
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
                variant="caption"
                tone="danger"
                role="alert"
                className="mt-2"
                data-testid="runtime-blocker-space-notice"
              >
                <Text as="p" variant="caption" tone="inherit">
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
          className="mt-2"
          data-testid="runtime-connection-warning"
        >
          <div>
            <Text as="p" variant="captionStrong" tone="inherit">
              Live runtime status is temporarily stale
            </Text>
            <Text as="p" variant="caption" tone="inherit">
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
            tone="muted"
            size="xs"
            radius="full"
            className="shrink-0"
          >
            Use best available
          </Button>
        </div>
      ) : null}
      {primaryRestartOption && onStartRuntime ? (
        <Button
          onPress={() => onStartRuntime(primaryRestartOption.id)}
          variant="primary"
          size="sm"
          radius="xl"
          fullWidth
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
      ) : (
        <div className="mt-2 px-2.5 py-3">
          <Text as="p" variant="caption" tone="muted">
            {emptyStateMessage}
          </Text>
          {!displayedRuntimeEnsureError && onRetryHosted ? (
            <Button
              onPress={handleRetryHosted}
              variant="primary"
              size="sm"
              isDisabled={hostedRuntimeTakeoverInProgress || retryHostedPending}
              radius="xl"
              fullWidth
              className="mt-3"
              data-testid="runtime-start-cloud"
            >
              {retryHostedPending ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner
                    tone="slate"
                    size="xs"
                    className="border-white/40 border-t-white"
                    aria-hidden="true"
                  />
                  Starting Instafy Cloud…
                </span>
              ) : (
                "Start Instafy Cloud"
              )}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
