import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, MoreHoriz, NavArrowDown, Play, Square, Trash } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { StudioMenu, StudioMenuItem } from "../../components/aria/StudioMenu";
import { StudioPopover } from "../../components/aria/StudioPopover";
import { useProjects } from "../../projects/useProjects";
import { useStatus } from "../../status/useStatus";
import {
  getRuntimeSizePreference,
  setRuntimeSizePreference,
  RUNTIME_SIZE_CHOICES,
  type RuntimeSizeId,
} from "../runtimeSizePreference";
import { RuntimeOptionMeta } from "./RuntimeOptionMeta";
import {
  formatCpuPct,
  formatUsagePair,
  resolveTunnelHostname,
  resolveTunnelUrl,
  RuntimeStateIndicator,
  tunnelGrantIsActive,
  writeClipboardText,
} from "../runtimeMenuShared";
import { getRuntimeResourceHistory } from "../runtimeResourceHistory";
import { RuntimeResourceSparklines } from "./RuntimeResourceSparklines";
import type { RuntimeMenuOption } from "../useRuntimeMenu";
import type { TunnelCopyMode } from "./RuntimeTunnelDetails";
import { Button, IconButton } from "../../components/Button";
import { Text } from "../../components/Text";

function formatRuntimeTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCpuLimitCores(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${rounded} cores`;
  }
  return `${rounded.toFixed(1)} cores`;
}

function formatRuntimeResources(option: RuntimeMenuOption): {
  summary: string;
  title?: string;
} | null {
  const resources = option.resources ?? null;
  if (!resources) {
    return null;
  }

  const segments: string[] = [];
  const cpuLimitCores = formatCpuLimitCores(resources.cpuLimitCores);
  const cpuPct = formatCpuPct(resources.cpuPct);
  if (cpuPct) {
    segments.push(cpuLimitCores ? `CPU ${cpuPct} (${cpuLimitCores})` : `CPU ${cpuPct}`);
  } else if (cpuLimitCores) {
    segments.push(`CPU ${cpuLimitCores}`);
  }
  const memory = formatUsagePair(resources.memoryUsedBytes, resources.memoryLimitBytes);
  if (memory) {
    segments.push(`RAM ${memory}`);
  }
  const disk = formatUsagePair(resources.diskUsedBytes, resources.diskLimitBytes);
  if (disk) {
    segments.push(`Disk ${disk}`);
  }

  if (segments.length === 0) {
    return null;
  }

  const updatedAt = resources.updatedAt?.trim();
  const title =
    updatedAt && !Number.isNaN(new Date(updatedAt).getTime())
      ? `Updated ${new Date(updatedAt).toLocaleString()}`
      : undefined;

  return { summary: segments.join(" · "), title };
}

interface RuntimeValueRowProps {
  label: string;
  value: string;
  displayValue?: string;
  mono?: boolean;
  copyLabel?: string;
  copyTestId?: string;
  onCopy?: () => void;
}

/**
 * One label/value pair inside the details definition grid. Renders two grid
 * cells (no wrapper), so the parent must be the two-column grid — that is what
 * keeps every value aligned on a single axis.
 */
function RuntimeValueRow({
  label,
  value,
  displayValue,
  mono = false,
  copyLabel = "Copy value",
  copyTestId,
  onCopy,
}: RuntimeValueRowProps) {
  return (
    <>
      <Text as="span" variant="caption" tone="muted">
        {label}
      </Text>
      <span className="flex min-w-0 items-center gap-1.5">
        <Text
          as="span"
          variant={mono ? "mono" : "caption"}
          tone="muted"
          className="min-w-0 flex-1 truncate tabular-nums"
          title={value}
        >
          {displayValue ?? value}
        </Text>
        {onCopy ? (
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            radius="full"
            onPress={() => onCopy()}
            aria-label={copyLabel}
            title={copyLabel}
            data-testid={copyTestId}
            tone="neutral"
            className="shrink-0"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        ) : null}
      </span>
    </>
  );
}

interface RuntimeMenuOptionsListProps {
  options: RuntimeMenuOption[];
  selectedRuntimeId: string | null;
  onSelectOption: (runtimeId: string | null) => void;
  onTerminateRuntime?: (runtimeId: string | null) => void;
  onRemoveRuntime?: (runtimeId: string | null) => void;
  onStartRuntime?: (runtimeId: string | null) => void;
  /**
   * Opens the self-host dialog. A self-hosted machine cannot be started from
   * the browser — Start/Stop/Remove are all gated on `!isLikelyLocal` — so an
   * offline self-hosted row otherwise carries no control at all, and anything
   * that sends the reader here just moves the dead end.
   */
  onShowSelfHostHelp?: () => void;
  className?: string;
  optionClassName?: string;
  selectedOptionClassName?: string;
  emptyStateMessage?: string;
  onCopyTunnel?: (mode: TunnelCopyMode, runtimeId: string | null) => void;
  copyDisabled?: boolean;
  /**
   * Option whose details start expanded (page-style hosts want stats visible
   * without a click). The user can still collapse it; absent = all collapsed.
   */
  defaultExpandedOptionId?: string | null;
  /** Extra host-supplied content rendered inside an option's expanded details. */
  renderOptionExtras?: (option: RuntimeMenuOption) => ReactNode;
  /** Trend size: compact mini-sparklines (menus) or full-row plots (pages). */
  sparklineVariant?: "compact" | "page";
  /**
   * Lifecycle controls (start/stop/remove) as header icon buttons instead of a
   * row at the bottom of the details — for page-style hosts where the card can
   * be tall. Remove still routes through the in-details confirm strip.
   */
  headerActions?: boolean;
  /** Pickers select from the row; management pages expand it to inspect first. */
  interactionMode?: "picker" | "manage";
}

/**
 * Machine size choice for the hosted runtime. The selection is a per-project
 * preference validated server-side; it applies the next time the machine
 * starts, and a boosted machine burns credits at the shown multiple. Each
 * menu option carries its own specs/cost so the price is visible BEFORE
 * choosing.
 */
function RuntimeSizePickerRow() {
  const { activeProjectId } = useProjects();
  const { showStatus } = useStatus();
  const [selected, setSelected] = useState<RuntimeSizeId>(() =>
    getRuntimeSizePreference(activeProjectId),
  );
  const sizeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);

  if (!activeProjectId) {
    return null;
  }

  const choose = (sizeId: RuntimeSizeId) => {
    if (sizeId === selected) {
      return;
    }
    setSelected(sizeId);
    setRuntimeSizePreference(activeProjectId, sizeId);
    const choice = RUNTIME_SIZE_CHOICES.find((entry) => entry.id === sizeId);
    showStatus(
      `${choice?.label ?? sizeId} applies the next time this machine starts — stop and start it from this menu to switch now.`,
      "info",
      7000,
      { id: "runtime-size-change", forceVisible: true },
    );
  };

  const selectedChoice = RUNTIME_SIZE_CHOICES.find((entry) => entry.id === selected);
  const triggerLabel = [selectedChoice?.label ?? selected, selectedChoice?.specs]
    .filter(Boolean)
    .join(" · ");

  // A row like everything else in the card — "Size" in the shared label
  // column, a compact dropdown as the value — instead of a two-cell segmented
  // block. Specs and cost stay visible in the menu BEFORE choosing.
  return (
    <div className="flex items-center gap-3" data-testid="runtime-size-picker">
      <Text as="span" variant="caption" tone="muted" className="w-14 shrink-0">
        Size
      </Text>
      <MenuTrigger isOpen={sizeMenuOpen} onOpenChange={setSizeMenuOpen}>
        <Button
          ref={sizeTriggerRef}
          type="button"
          variant="outline"
          size="sm"
          radius="lg"
          aria-label="Machine size"
          aria-haspopup="menu"
          data-testid="runtime-size-trigger"
          onPress={() => {
            if (!sizeMenuOpen) setSizeMenuOpen(true);
          }}
          className="justify-between gap-1"
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <NavArrowDown className="shrink-0 text-xs text-slate-400" aria-hidden="true" />
        </Button>
        <StudioPopover
          triggerRef={sizeTriggerRef}
          isNonModal
          placement="bottom start"
          offset={4}
          className="min-w-[13rem] p-2"
        >
          <StudioMenu
            aria-label="Machine size"
            selectionMode="single"
            selectedKeys={new Set([selected])}
            onAction={(key) => {
              choose(String(key) as RuntimeSizeId);
              setSizeMenuOpen(false);
            }}
            className="space-y-1"
          >
            {RUNTIME_SIZE_CHOICES.map((choice) => (
              <StudioMenuItem
                key={choice.id}
                id={choice.id}
                data-testid={`runtime-size-${choice.id}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{choice.label}</span>
                  <Text as="span" variant="caption" tone="muted" className="font-normal">
                    {[choice.specs, choice.costNote].filter(Boolean).join(" · ")}
                  </Text>
                </span>
              </StudioMenuItem>
            ))}
          </StudioMenu>
        </StudioPopover>
      </MenuTrigger>
    </div>
  );
}

const DEFAULT_OPTION_CLASS =
  "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition pointer-coarse:min-h-11 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[var(--color-studio-dark-floating)]";

export function RuntimeMenuOptionsList({
  options,
  selectedRuntimeId,
  onSelectOption,
  onTerminateRuntime,
  onRemoveRuntime,
  onStartRuntime,
  onShowSelfHostHelp,
  className = "mt-1 max-h-64 overflow-auto",
  optionClassName = DEFAULT_OPTION_CLASS,
  selectedOptionClassName = "bg-slate-100 text-slate-900",
  emptyStateMessage = "No runtimes connected.",
  onCopyTunnel,
  copyDisabled = false,
  defaultExpandedOptionId = null,
  renderOptionExtras,
  sparklineVariant = "compact",
  headerActions = false,
  interactionMode = "picker",
}: RuntimeMenuOptionsListProps) {
  const listId = useId();
  const managesMachines = interactionMode === "manage";
  const { showStatus } = useStatus();
  const [expandedOptionId, setExpandedOptionId] = useState<string | null>(null);
  const [removeConfirmOptionId, setRemoveConfirmOptionId] = useState<string | null>(null);
  const removeTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const optionRefs = useRef(new Map<string, HTMLDivElement>());
  const restoreRemoveFocusTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (removeConfirmOptionId === null && restoreRemoveFocusTo.current !== null) {
      removeTriggerRefs.current.get(restoreRemoveFocusTo.current)?.focus();
      restoreRemoveFocusTo.current = null;
    }
  }, [removeConfirmOptionId]);

  const copyWithFeedback = (value: string, message: string) => {
    void writeClipboardText(value).then(
      // Plain "info"/"success" toasts are gated off by StatusProvider; a
      // confirmation presentation is the sanctioned transient copy ack.
      () =>
        showStatus(message, "success", 2200, {
          id: "runtime-copy-feedback",
          presentation: "confirmation",
        }),
      () => showStatus("Copy failed", "error", 4000, { id: "runtime-copy-feedback" }),
    );
  };

  if (options.length === 0) {
    return (
      <div className={className}>
        <div className="px-2.5 py-3">
          <Text as="p" variant="bodyCompact" tone="secondary">
            {emptyStateMessage}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {options.map((option, index) => {
        const optionKey = option.id ?? option.label;
        const detailsId = `${listId}-details-${index}`;
        const isSelected = option.id === selectedRuntimeId;
        // "__none__" marks a deliberate collapse of the default-open option;
        // plain null still means "nothing toggled yet" so the default applies.
        const effectiveExpandedId =
          expandedOptionId === "__none__"
            ? null
            : expandedOptionId ?? defaultExpandedOptionId;
        const isExpanded = effectiveExpandedId === optionKey;
        const toggleDetails = () => {
          setExpandedOptionId(() => (isExpanded ? "__none__" : optionKey));
          // Collapsing must disarm a pending remove confirmation, otherwise a
          // later re-expand re-mounts the confirm strip.
          setRemoveConfirmOptionId((current) => (current === optionKey ? null : current));
        };
        const isConfirmingRemove = removeConfirmOptionId === optionKey;

        const formattedLaunch = formatRuntimeTimestamp(option.launchedAt);
        const formattedLastSeen = formatRuntimeTimestamp(option.runtimeLastSeenAt);
        const resources = formatRuntimeResources(option);
        const runtimeIdValue = option.id?.trim() ?? null;
        const isHostedOption = (option.provider ?? "")
          .trim()
          .toLowerCase()
          .replace(/_/g, "-")
          .startsWith("instafy-cloud");
        const runtimeImageValue = option.runtimeImage?.trim() ?? null;
        const tunnelUrl = resolveTunnelUrl(option.tunnel);
        const tunnelHost = resolveTunnelHostname(option.tunnel);
        const tunnelCanCopy = tunnelGrantIsActive(option.tunnel);
        const endpointMatchesTunnel =
          Boolean(option.endpoint) &&
          (option.endpoint === tunnelUrl ||
            option.endpoint === tunnelHost ||
            (tunnelHost ? option.endpoint === `https://${tunnelHost}` : false) ||
            (tunnelHost ? option.endpoint === `http://${tunnelHost}` : false));
        const shouldShowEndpoint = Boolean(option.endpoint) && !endpointMatchesTunnel;
        const shouldShowDetailText =
          Boolean(option.detail) && !option.endpoint && !option.tunnel;
        const shouldShowHost = Boolean(tunnelHost);
        const resourceHistory = getRuntimeResourceHistory(option.id);
        // Lifecycle collapses to one line: recency when we have it, launch
        // time as the fallback.
        // A healthy machine's most useful lifecycle fact is how long it's been
        // up; fall back to recency/launch time otherwise.
        const uptimeValue = (() => {
          if (!["ready", "online", "healthy"].includes(String(option.state ?? "").toLowerCase())) {
            return null;
          }
          const launched = Date.parse(option.launchedAt ?? "");
          if (!Number.isFinite(launched)) return null;
          const totalMinutes = Math.max(0, Math.floor((Date.now() - launched) / 60000));
          const days = Math.floor(totalMinutes / 1440);
          const hours = Math.floor((totalMinutes % 1440) / 60);
          const minutes = totalMinutes % 60;
          if (days > 0) return `${days}d ${hours}h`;
          if (hours > 0) return `${hours}h ${minutes}m`;
          return `${minutes}m`;
        })();
        const lifecycleRow = uptimeValue
          ? { label: "Uptime", value: uptimeValue }
          : formattedLastSeen
            ? { label: "Last seen", value: formattedLastSeen }
            : formattedLaunch
              ? { label: "Launched", value: formattedLaunch }
            : null;
        const hasDetails =
          Boolean(runtimeIdValue) ||
          Boolean(runtimeImageValue) ||
          Boolean(lifecycleRow) ||
          shouldShowDetailText ||
          shouldShowEndpoint ||
          Boolean(resources) ||
          shouldShowHost ||
          isHostedOption;
        const canTerminate =
          Boolean(onTerminateRuntime) && Boolean(option.id) && !option.isLikelyLocal;
        const canRemove =
          Boolean(onRemoveRuntime) && Boolean(option.id) && !option.isLikelyLocal;
        const canStart =
          Boolean(onStartRuntime) &&
          Boolean(option.id) &&
          !option.isLikelyLocal &&
          option.state === "offline";
        const canShowSelfHostHelp =
          Boolean(onShowSelfHostHelp) && option.isLikelyLocal && option.state === "offline";
        const hasActions =
          managesMachines || hasDetails || canStart || canTerminate || canRemove || canShowSelfHostHelp;
        const activateRow = () => {
          if (managesMachines) toggleDetails();
          else onSelectOption(option.id);
        };
        const disclosureIcon = (
          <NavArrowDown
            className={`h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none ${isExpanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        );

        return (
          <div
            key={optionKey}
            // Stable hook for cross-surface deep-links (the Machines page
            // scrolls the focused machine into view by this id).
            data-runtime-option-id={option.id ?? "auto"}
            className="flex w-full flex-col"
          >
            {/* The pressable selection surface and the disclosure toggle are
                siblings: interactive elements must not nest inside the
                header's role="button". */}
            <div className={`flex w-full items-center gap-1 rounded-xl pr-1 transition hover:bg-slate-100 active:bg-slate-200/80 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:active:bg-[var(--color-studio-dark-active)] ${isSelected ? selectedOptionClassName : ""}`}>
              <div
                ref={(node) => {
                  if (node) optionRefs.current.set(optionKey, node);
                  else optionRefs.current.delete(optionKey);
                }}
                role="button"
                tabIndex={0}
                aria-pressed={managesMachines ? undefined : isSelected}
                aria-expanded={managesMachines ? isExpanded : undefined}
                aria-controls={managesMachines ? detailsId : undefined}
                onClick={activateRow}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activateRow();
                  }
                }}
                className={optionClassName}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  {/* h-5 = the title's 20px line box, so the dot's midline sits
                      on the title's midline (h-7 floated it 4px low). */}
                  <span className="flex h-5 flex-none items-center" aria-hidden="true">
                    <RuntimeStateIndicator option={option} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <RuntimeOptionMeta
                      option={option}
                      showDetail={false}
                      showProviderBadge={false}
                      // The header includes the machine's id (full value on
                      // hover); the details grid carries no separate ID row.
                      showRuntimeIdBadge
                      className="flex min-w-0 flex-col gap-0.5"
                    />
                    {/* The one-line stats summary is the COLLAPSED view; expanded,
                        the trend rows below show the same numbers. */}
                    {resources && !isExpanded ? (
                      <Text
                        as="span"
                        variant="caption"
                        tone="secondary"
                        className="block break-words pr-1"
                        title={resources.title}
                      >
                        {resources.summary}
                      </Text>
                    ) : null}
                  </div>
                </div>
                {isSelected ? (
                  <span className="flex h-5 shrink-0 items-center" title="Selected">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Selected</span>
                  </span>
                ) : null}
                {managesMachines ? disclosureIcon : null}
              </div>
              {headerActions && canStart ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  radius="full"
                  aria-label={`Start ${option.label}`}
                  title="Start"
                  onPress={() => onStartRuntime?.(option.id ?? null)}
                  tone="neutral"
                  className="shrink-0"
                >
                  <Play className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : null}
              {headerActions && canTerminate && !canStart ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  radius="full"
                  aria-label={`Stop ${option.label}`}
                  title="Stop"
                  onPress={() => onTerminateRuntime?.(option.id ?? null)}
                  tone="neutral"
                  className="shrink-0"
                >
                  <Square className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : null}
              {headerActions && canRemove ? (
                <MenuTrigger>
                  <IconButton
                    ref={(node) => {
                      if (node) removeTriggerRefs.current.set(optionKey, node);
                      else removeTriggerRefs.current.delete(optionKey);
                    }}
                    variant="ghost"
                    size="sm"
                    radius="full"
                    aria-label={`More actions for ${option.label}`}
                    title="More actions"
                    tone="neutral"
                    className="shrink-0"
                  >
                    <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <StudioPopover placement="bottom end" className="min-w-40 p-1">
                    <StudioMenu aria-label={`Actions for ${option.label}`}>
                      <StudioMenuItem id="remove" onAction={() => {
                        // Opening confirmation never removes the machine.
                        setExpandedOptionId(optionKey);
                        setRemoveConfirmOptionId(optionKey);
                      }}>
                        Remove machine…
                      </StudioMenuItem>
                    </StudioMenu>
                  </StudioPopover>
                </MenuTrigger>
              ) : null}
              {hasActions && !managesMachines ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  radius="full"
                  tone="neutral"
                  className="shrink-0"
                  aria-label={isExpanded ? "Hide runtime details" : "Show runtime details"}
                  aria-expanded={isExpanded}
                  aria-controls={detailsId}
                  title={isExpanded ? "Hide runtime details" : "Show runtime details"}
                  onPress={toggleDetails}
                >
                  {disclosureIcon}
                </IconButton>
              ) : null}
            </div>
            {hasActions && isExpanded ? (
              // pl-4.5 = the state indicator (w-2.5) + the header's gap-2, so
              // the details sit exactly flush with the title text: a hanging
              // indent with the dot alone in the gutter.
              <div
                id={detailsId}
                className="mx-2.5 mt-1 flex flex-col gap-2.5 pb-3 pl-4.5 pt-2"
              >
                {managesMachines ? (
                  <div className="flex min-h-8 items-center pointer-coarse:min-h-11">
                    {isSelected ? (
                      <Text as="span" variant="caption" tone="muted">
                        Selected machine
                      </Text>
                    ) : (
                      <Button
                        variant="secondary"
                        elevation="none"
                        size="sm"
                        radius="full"
                        onPress={() => {
                          onSelectOption(option.id);
                          // The action becomes status text; keep keyboard focus
                          // on the stable row rather than the removed button.
                          optionRefs.current.get(optionKey)?.focus();
                        }}
                      >
                        Use this machine
                      </Button>
                    )}
                  </div>
                ) : null}
                {shouldShowDetailText ? (
                  <Text as="p" variant="bodyCompact" tone="secondary" className="break-words">
                    {option.detail}
                  </Text>
                ) : null}
                {isHostedOption ? (
                  <div data-testid="runtime-hosted-machine-facts">
                    <RuntimeSizePickerRow />
                  </div>
                ) : null}
                {resourceHistory.length > 0 ? (
                  <RuntimeResourceSparklines
                    history={resourceHistory}
                    variant={sparklineVariant}
                  />
                ) : null}
                {renderOptionExtras ? renderOptionExtras(option) : null}
                {runtimeImageValue || shouldShowEndpoint || shouldShowHost || lifecycleRow ? (
                  // Fixed label column so these rows share a content edge with
                  // the trend plots above (page variant sizes its labels to
                  // match); the machine id lives in the header only.
                  <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
                    {runtimeImageValue ? (
                      <RuntimeValueRow
                        label="Image"
                        value={runtimeImageValue}
                        mono
                        copyLabel="Copy runtime image"
                        copyTestId={option.id ? `runtime-copy-image-${option.id}` : undefined}
                        onCopy={() => {
                          copyWithFeedback(runtimeImageValue, "Runtime image copied");
                        }}
                      />
                    ) : null}
                    {shouldShowEndpoint ? (
                      <RuntimeValueRow
                        label="Endpoint"
                        value={option.endpoint ?? ""}
                        mono
                        copyLabel="Copy endpoint"
                        copyTestId={option.id ? `runtime-copy-endpoint-${option.id}` : undefined}
                        onCopy={() => {
                          if (!option.endpoint) {
                            return;
                          }
                          copyWithFeedback(option.endpoint, "Endpoint copied");
                        }}
                      />
                    ) : null}
                    {tunnelHost ? (
                      <RuntimeValueRow
                        label="Host"
                        value={tunnelHost}
                        mono
                        copyLabel="Copy host"
                        copyTestId={option.id ? `runtime-copy-tunnel-host-${option.id}` : undefined}
                        onCopy={
                          !copyDisabled && tunnelCanCopy
                            ? onCopyTunnel && option.id
                              ? () => onCopyTunnel("host", option.id ?? null)
                              : () => {
                                  copyWithFeedback(tunnelHost, "Host copied");
                                }
                            : undefined
                        }
                      />
                    ) : null}
                    {lifecycleRow ? (
                      <RuntimeValueRow label={lifecycleRow.label} value={lifecycleRow.value} />
                    ) : null}
                  </div>
                ) : null}
                {canShowSelfHostHelp ? (
                  <div className="flex flex-col gap-1.5">
                    <Text as="p" variant="bodyCompact" tone="secondary">
                      Self-hosted machines start from the computer they run on.
                    </Text>
                    <div>
                      <Button
                        onPress={() => onShowSelfHostHelp?.()}
                        variant="ghost"
                        size="sm"
                        radius="full"
                        tone="neutral"
                        className="gap-1.5"
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        How to start it
                      </Button>
                    </div>
                  </div>
                ) : null}
                {!headerActions && (canStart || canTerminate || canRemove) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {canStart ? (
                      <Button
                        onPress={() => onStartRuntime?.(option.id ?? null)}
                        variant="ghost"
                        size="sm"
                        radius="full"
                        tone="neutral"
                        className="gap-1.5"
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        Start
                      </Button>
                    ) : null}
                    {canTerminate && !canStart ? (
                      <Button
                        onPress={() => onTerminateRuntime?.(option.id ?? null)}
                        variant="ghost"
                        size="sm"
                        radius="full"
                        tone="neutral"
                        className="gap-1.5"
                      >
                        <Square className="h-3.5 w-3.5" aria-hidden="true" />
                        Stop
                      </Button>
                    ) : null}
                    {canRemove && !isConfirmingRemove ? (
                      <Button
                        ref={(node) => {
                          if (node) removeTriggerRefs.current.set(optionKey, node);
                          else removeTriggerRefs.current.delete(optionKey);
                        }}
                        onPress={() => setRemoveConfirmOptionId(optionKey)}
                        variant="ghost"
                        size="sm"
                        radius="full"
                        tone="danger"
                        className="ml-auto gap-1.5"
                      >
                        <Trash className="h-3.5 w-3.5" aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {canRemove && isConfirmingRemove ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <Text as="span" variant="bodyCompact" tone="danger">
                      Remove “{option.label}”?
                    </Text>
                    <div className="flex items-center gap-1.5">
                      {/* Focus enters the strip on the safe action, never on
                          the destructive one. */}
                      <Button
                        onPress={() => {
                          restoreRemoveFocusTo.current = optionKey;
                          setRemoveConfirmOptionId(null);
                        }}
                        variant="ghost"
                        size="sm"
                        radius="full"
                        autoFocus
                      >
                        Cancel
                      </Button>
                      <Button
                        onPress={() => {
                          setRemoveConfirmOptionId(null);
                          onRemoveRuntime?.(option.id ?? null);
                        }}
                        variant="ghost"
                        tone="danger"
                        size="sm"
                        radius="full"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
