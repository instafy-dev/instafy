import { useCallback, useMemo, useState } from "react";
import { DialogTrigger } from "react-aria-components";
import { Cpu, CpuWarning, NavArrowDown, Plus } from "iconoir-react";
import { RuntimeMenuPanel } from "./RuntimeMenuPanel";
import type { TunnelCopyMode } from "./RuntimeTunnelDetails";
import { StudioDialogPopover } from "../../components/aria/StudioPopover";
import { Button } from "../../components/Button";
import { MenuItemContent } from "../../components/MenuItemContent";
import { Spinner } from "../../components/Spinner";
import { Text } from "../../components/Text";
import {
  runtimeEntryIsBooting,
  runtimeEntryIsReady,
} from "../utils/runtimeEntry";

type RuntimeMenuHookResult = ReturnType<
  typeof import("../useRuntimeMenu").useRuntimeMenuOptions
>;

interface RuntimeSelectorCompactProps {
  runtimeMenu: RuntimeMenuHookResult;
  runtimeReady: boolean;
}

export function RuntimeSelectorCompact({
  runtimeMenu,
  runtimeReady,
}: RuntimeSelectorCompactProps) {
  const {
    runtime: runtimeContext,
    runtimeOptions,
    currentRuntime,
  } = runtimeMenu;
  const {
    preferredRuntimeId,
    setPreferredRuntime,
    clearSessionRuntimeOverride,
    ensureHostedRuntime,
    hostedRuntimeEnsuring,
    hostedRuntimeTakeoverInProgress,
    takeOverHostedRuntimeLimit,
    showDesktopRuntimeHelp,
    copyTunnelDetails,
    runtimeStatuses,
    terminateRuntime,
    removeRuntime,
    startRuntime,
    runtimeEnsureError,
    runtimeEnsureLimit,
  } = runtimeContext;
  const runtimeConnectionWarning = runtimeContext.runtime
    .controllerStreamDisconnected
    ? runtimeContext.runtime.controllerStreamDisconnectMessage ??
      "Lost live runtime updates. Retrying…"
    : null;
  const [menuOpen, setMenuOpen] = useState(false);

  const readyRuntimeEntry = useMemo(
    () => runtimeStatuses.find((entry) => runtimeEntryIsReady(entry)),
    [runtimeStatuses],
  );
  const connectingRuntimeEntry = useMemo(
    () => runtimeStatuses.find((entry) => runtimeEntryIsBooting(entry)),
    [runtimeStatuses],
  );
  const connectionInProgress = hostedRuntimeEnsuring || Boolean(connectingRuntimeEntry);
  const isConnecting = connectionInProgress && !readyRuntimeEntry;
  const connectingLabelFallback = hostedRuntimeEnsuring ? "Instafy Cloud" : currentRuntime.label;
  const activeLabel = isConnecting
    ? connectingRuntimeEntry?.displayName ??
      connectingRuntimeEntry?.runtimeId ??
      connectingLabelFallback
    : currentRuntime.isAuto && readyRuntimeEntry
        ? readyRuntimeEntry.displayName ?? readyRuntimeEntry.runtimeId ?? currentRuntime.label
        : currentRuntime.label;

  const handleSelect = (runtimeId: string | null) => {
    setMenuOpen(false);
    clearSessionRuntimeOverride();
    void setPreferredRuntime(runtimeId);
  };

  const handleEnsureHosted = useCallback(() => {
    setMenuOpen(false);
    void ensureHostedRuntime();
  }, [ensureHostedRuntime]);

  const handleDesktopHelp = useCallback(() => {
    setMenuOpen(false);
    showDesktopRuntimeHelp();
  }, [showDesktopRuntimeHelp]);

  const handleCopyTunnel = useCallback(
    (mode: TunnelCopyMode, runtimeId?: string | null) => {
      void copyTunnelDetails(mode, runtimeId ?? currentRuntime.id ?? null);
    },
    [copyTunnelDetails, currentRuntime.id],
  );

  const handleTerminateRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeId) {
        return;
      }
      await terminateRuntime(runtimeId);
    },
    [terminateRuntime],
  );

  const handleRemoveRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeId) return;
      await removeRuntime(runtimeId);
    },
    [removeRuntime],
  );

  const handleStartRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeId) return;
      await startRuntime(runtimeId);
    },
    [startRuntime],
  );

  const compactStatus: "error" | "loading" | "warning" | "ready" | "offline" =
    runtimeEnsureError
      ? "error"
      : isConnecting
        ? "loading"
        : runtimeConnectionWarning
          ? "warning"
          : runtimeReady
            ? "ready"
            : "offline";

  const compactClassName = [
    "gap-1.5 px-2.5 sm:gap-2 sm:px-3 sm:py-1.5",
    compactStatus === "ready"
      ? "border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 data-[hovered]:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200 dark:hover:bg-primary-500/15 dark:data-[hovered]:bg-primary-500/15"
      : "",
    compactStatus === "loading"
      ? "border-secondary-200 bg-secondary-50 text-secondary-700 hover:bg-secondary-100 data-[hovered]:bg-secondary-100 dark:border-secondary-500/30 dark:bg-secondary-500/10 dark:text-secondary-200 dark:hover:bg-secondary-500/15 dark:data-[hovered]:bg-secondary-500/15"
      : "",
    compactStatus === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 data-[hovered]:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/15 dark:data-[hovered]:bg-amber-500/15"
      : "",
    compactStatus === "error"
      ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 data-[hovered]:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15 dark:data-[hovered]:bg-rose-500/15"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="relative">
      <DialogTrigger
        isOpen={menuOpen}
        onOpenChange={(open) => setMenuOpen((current) => (open && current ? false : open))}
      >
        <Button
          variant="outline"
          size="xs"
          radius="full"
          className={compactClassName}
          data-testid="runtime-selector-button"
          aria-label={`Runtime: ${activeLabel}`}
          title={activeLabel}
        >
          <Text as="span" variant="bodyStrong" tone="inherit" className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <span className="flex h-5 w-5 items-center justify-center" aria-hidden="true">
              {compactStatus === "error" ? (
                <CpuWarning className="h-4 w-4" aria-hidden="true" />
              ) : compactStatus === "warning" ? (
                <CpuWarning className="h-4 w-4" aria-hidden="true" />
              ) : compactStatus === "loading" ? (
                <Spinner aria-hidden="true" tone="secondary" size="xs" />
              ) : compactStatus === "ready" ? (
                <span
                  className="h-2.5 w-2.5 rounded-full bg-primary-600 shadow-[0_0_0_2px_rgba(0,122,204,0.15)] dark:bg-primary-400 dark:shadow-[0_0_0_2px_rgba(55,148,255,0.18)]"
                  aria-hidden="true"
                />
              ) : (
                <Cpu className="h-4 w-4" aria-hidden="true" />
              )}
            </span>
            <span className="hidden min-w-0 truncate sm:inline">{activeLabel}</span>
          </Text>
          <NavArrowDown className="text-base opacity-70" aria-hidden="true" />
        </Button>
        <StudioDialogPopover
          placement="top start"
          offset={8}
          className="w-[min(92vw,24rem)] p-3"
          data-testid="runtime-selector-popover"
        >
          <RuntimeMenuPanel
            runtimeEnsureError={runtimeEnsureError}
            runtimeEnsureLimit={runtimeEnsureLimit}
            connectionWarning={runtimeConnectionWarning}
            hostedRuntimeEnsuring={hostedRuntimeEnsuring}
            onClose={() => setMenuOpen(false)}
            onRetryHosted={ensureHostedRuntime}
            onTakeOverHostedRuntimeLimit={takeOverHostedRuntimeLimit}
            hostedRuntimeTakeoverInProgress={hostedRuntimeTakeoverInProgress}
            runtimeOptions={runtimeOptions}
            selectedRuntimeId={preferredRuntimeId}
            onSelectOption={handleSelect}
            onTerminateRuntime={handleTerminateRuntime}
            onRemoveRuntime={handleRemoveRuntime}
            onStartRuntime={handleStartRuntime}
            onCopyTunnel={handleCopyTunnel}
            listClassName="mt-3 max-h-56 overflow-auto"
            emptyStateMessage="No runtimes available yet."
          />
          <div className="my-3 h-px bg-slate-200 dark:bg-[var(--color-studio-dark-divider)]" />
          <div className="flex flex-col gap-2">
            {runtimeOptions.length > 0 && !runtimeEnsureError ? (
              <Button
                onPress={handleEnsureHosted}
                variant="outline"
                size="sm"
                radius="xl"
                fullWidth
                isDisabled={hostedRuntimeEnsuring}
                className="justify-start border-primary-200 text-primary-600 hover:bg-primary-50 data-[hovered]:bg-primary-50 dark:border-primary-500/35 dark:bg-primary-500/10 dark:text-primary-200 dark:hover:bg-primary-500/15 dark:data-[hovered]:bg-primary-500/15"
                data-testid="runtime-new-cloud"
              >
                <MenuItemContent
                  start={
                    hostedRuntimeEnsuring ? (
                      <Spinner aria-hidden="true" tone="primary" size="xs" />
                    ) : (
                      <Plus aria-hidden="true" />
                    )
                  }
                  startClassName="shrink-0 text-base text-primary-600 dark:text-primary-400"
                >
                  <Text as="span" variant="bodyStrong" tone="inherit">
                    New Instafy Cloud runtime
                  </Text>
                </MenuItemContent>
              </Button>
            ) : null}
            <Button
              onPress={handleDesktopHelp}
              variant="outline"
              size="sm"
              radius="xl"
              fullWidth
              className="justify-start text-slate-600 dark:text-slate-200"
              data-testid="runtime-new-selfhosted"
            >
              <MenuItemContent start={<Cpu aria-hidden="true" />}>
                <Text as="span" variant="bodyStrong" tone="inherit">
                  Self-host a runtime
                </Text>
              </MenuItemContent>
            </Button>
          </div>
        </StudioDialogPopover>
      </DialogTrigger>
    </div>
  );
}
