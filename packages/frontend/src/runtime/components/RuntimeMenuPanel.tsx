import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Play, Refresh, WarningTriangle, Xmark } from "iconoir-react";
import type { RuntimeMenuOption } from "../useRuntimeMenu";
import { RuntimeMenuOptionsList } from "./RuntimeMenuOptionsList";
import type { TunnelCopyMode } from "./RuntimeTunnelDetails";
import {
  parseHostedRuntimeLimitError,
  type HostedRuntimeLimitErrorDetails,
} from "../hostedRuntimeLimitError";
import { Button, IconButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { Spinner } from "../../components/Spinner";
import { Text } from "../../components/Text";

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
  onCopyTunnel?: (mode: TunnelCopyMode, runtimeId?: string | null) => void;
  listClassName?: string;
  emptyStateMessage?: string;
  /** Option whose details start expanded (page-style hosts). */
  defaultExpandedOptionId?: string | null;
  /** Extra host content rendered inside an option's expanded details. */
  renderOptionExtras?: (option: RuntimeMenuOption) => ReactNode;
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
  onCopyTunnel,
  listClassName = "mt-2 max-h-60 overflow-auto",
  emptyStateMessage = "No runtimes available yet.",
  defaultExpandedOptionId = null,
  renderOptionExtras,
}: RuntimeMenuPanelProps) {
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [cachedRuntimeEnsureError, setCachedRuntimeEnsureError] = useState<string | null>(null);
  const [cachedRuntimeEnsureLimit, setCachedRuntimeEnsureLimit] =
    useState<HostedRuntimeLimitErrorDetails | null>(null);
  const [runtimeActionError, setRuntimeActionError] = useState<string | null>(null);
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
    try {
      const result = await onTakeOverHostedRuntimeLimit();
      if (result === false) {
        setRuntimeActionError(
          "Runtime takeover did not complete. Open details or retry after cleanup.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeActionError(`Unable to take over runtime: ${message}`);
    }
  };
  const handleRetryHosted = async () => {
    setRuntimeActionError(null);
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
          <Text as="div" variant="caption" tone="subtle" className="text-xxs font-medium">
            {title}
          </Text>
          {onClose ? (
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              onPress={onClose}
              aria-label="Close runtimes menu"
              className="text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      {displayedRuntimeEnsureError ? (
        <Card
          tone="warning"
          radius="xl"
          shadow="none"
          padding="sm"
          className="mt-2 flex items-start gap-2 py-2 text-xs text-secondary-800"
        >
          <WarningTriangle className="mt-0.5 h-4 w-4 text-secondary-500" aria-hidden="true" />
          <div className="flex-1">
            <Text as="p" variant="caption" tone="inherit" className="font-medium">
              {errorHeadline}
            </Text>
            <Text as="p" variant="caption" tone="inherit" className="text-xxs leading-snug">
              {errorSummary}
            </Text>
            {limitReached ? (
              <>
                {blockerProjectLabel ? (
                  <Text as="p" variant="caption" tone="inherit" className="mt-1 text-xxs leading-snug">
                    Blocking runtime: {blockerRuntimeLabel ?? "active runtime"}.
                  </Text>
                ) : null}
                <Text as="p" variant="caption" tone="inherit" className="mt-1 text-xxs leading-snug">
                  Stop a stale runtime or retry after cleanup. Stopping a blocker can interrupt work on that runtime.
                </Text>
              </>
            ) : null}
            {displayedRuntimeEnsureError ? (
              <Button
                onPress={() => setShowErrorDetails((current) => !current)}
                variant="ghost"
                size="xs"
                radius="full"
                className="mt-2 px-0 text-xxs text-secondary-700 underline decoration-secondary-400 underline-offset-4 hover:bg-transparent hover:text-secondary-800 data-[hovered]:bg-transparent"
              >
                {showErrorDetails ? "Hide details" : "View details"}
              </Button>
            ) : null}
            {displayedRuntimeEnsureError && showErrorDetails ? (
              <Text
                as="pre"
                variant="mono"
                tone="inherit"
                className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-secondary-100/80 p-2 text-3xs leading-snug text-secondary-900 dark:bg-secondary-950/40 dark:text-secondary-100"
              >
                {displayedRuntimeEnsureError}
              </Text>
            ) : null}
            {limitReached && hasTakeoverBlocker && onTakeOverHostedRuntimeLimit ? (
              <Button
                onPress={handleTakeOverHostedRuntimeLimit}
                variant="ghost"
                size="xs"
                radius="full"
                isDisabled={hostedRuntimeTakeoverInProgress}
                className="mt-2 px-0 text-xxs text-secondary-700 underline decoration-secondary-400 underline-offset-4 hover:bg-transparent hover:text-secondary-800 data-[hovered]:bg-transparent"
              >
                {hostedRuntimeTakeoverInProgress
                  ? "Stopping blocker..."
                  : "Stop blocker and retry"}
              </Button>
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
                tone="inherit"
                className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-2 py-1.5 text-xxs leading-snug text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-100"
                data-testid="runtime-action-error"
              >
                {runtimeActionError}
              </Text>
            ) : null}
          </div>
        </Card>
      ) : null}
      {connectionWarning ? (
        <Card
          tone="warning"
          radius="xl"
          shadow="none"
          padding="sm"
          className="mt-2 flex items-start gap-2 py-2 text-xs text-secondary-800"
          data-testid="runtime-connection-warning"
        >
          <WarningTriangle className="mt-0.5 h-4 w-4 text-secondary-500" aria-hidden="true" />
          <div className="flex-1">
            <Text as="p" variant="caption" tone="inherit" className="font-medium">
              Live runtime status is temporarily stale
            </Text>
            <Text as="p" variant="caption" tone="inherit" className="text-xxs leading-snug">
              {connectionWarning}
            </Text>
          </div>
        </Card>
      ) : null}
      {pinnedRuntimeLabel ? (
        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <Text as="div" variant="caption" tone="muted" className="min-w-0 truncate text-xxs">
            {selectionPinnedPrefix} {pinnedRuntimeLabel}
          </Text>
          <Button
            onPress={() => onSelectOption(null)}
            variant="ghost"
            size="xs"
            radius="full"
            className="shrink-0 px-0 text-xxs text-slate-600 underline decoration-slate-300 underline-offset-4 hover:bg-transparent hover:text-slate-800 data-[hovered]:bg-transparent dark:text-slate-300 dark:hover:text-slate-100"
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
          className={listClassName}
          selectedOptionClassName="bg-slate-100 font-medium text-slate-900 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-50"
          emptyStateMessage={emptyStateMessage}
          onCopyTunnel={onCopyTunnel}
          copyDisabled={false}
          defaultExpandedOptionId={defaultExpandedOptionId}
          renderOptionExtras={renderOptionExtras}
        />
      ) : (
        <Card
          tone="raised"
          radius="xl"
          shadow="none"
          padding="sm"
          className="mt-2 border-dashed py-4 text-center text-xs text-slate-500 dark:text-slate-300"
        >
          <Text as="p" variant="caption" tone="inherit" className="leading-relaxed">
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
        </Card>
      )}
    </div>
  );
}
