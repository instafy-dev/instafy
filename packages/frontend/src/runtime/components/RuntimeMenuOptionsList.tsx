import { useState, type ReactNode } from "react";
import { Copy, NavArrowDown, Play, Square, Trash } from "iconoir-react";
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
import { Card } from "../../components/Card";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Text } from "../../components/Text";
import { DARK_DIVIDER_BORDER_CLASS } from "../../theme/darkSurfaces";
import { compactIdentifier } from "../../utils/compactIdentifier";

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
      <Text as="span" variant="caption" tone="muted" className="text-xxs">
        {label}
      </Text>
      <span className="flex min-w-0 items-center gap-1.5">
        <Text
          as="span"
          variant={mono ? "mono" : "caption"}
          tone="secondary"
          className="min-w-0 flex-1 truncate text-xxs tabular-nums"
          title={value}
        >
          {displayValue ?? value}
        </Text>
        {onCopy ? (
          <IconButton
            type="button"
            variant="ghost"
            size="xs"
            radius="full"
            onPress={() => onCopy()}
            aria-label={copyLabel}
            title={copyLabel}
            data-testid={copyTestId}
            className="shrink-0 text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50"
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
}

/**
 * Machine size choice for the hosted runtime. The selection is a per-project
 * preference validated server-side; it applies the next time the machine
 * starts, and a boosted machine burns credits at the shown multiple. Each
 * segment carries its own specs/cost so the price is visible BEFORE choosing.
 */
function RuntimeSizePickerRow() {
  const { activeProjectId } = useProjects();
  const { showStatus } = useStatus();
  const [selected, setSelected] = useState<RuntimeSizeId>(() =>
    getRuntimeSizePreference(activeProjectId),
  );

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

  return (
    <div data-testid="runtime-size-picker">
      <SegmentedControl
        label="Machine size"
        size="xs"
        width="fit"
        value={selected}
        onChange={choose}
        options={RUNTIME_SIZE_CHOICES.map((choice) => {
          const detail = [choice.specs, choice.costNote].filter(Boolean).join(" · ");
          return {
            value: choice.id,
            label: (
              <span className="flex flex-col items-center leading-tight">
                <span>{choice.label}</span>
                <span className="whitespace-nowrap text-3xs font-normal text-slate-500 dark:text-slate-400">
                  {detail}
                </span>
              </span>
            ),
            ariaLabel: [choice.label, choice.specs, choice.costNote]
              .filter(Boolean)
              .join(", "),
            testId: `runtime-size-${choice.id}`,
          };
        })}
      />
    </div>
  );
}

const DEFAULT_OPTION_CLASS =
  "flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-xl px-2.5 py-1.5 text-left transition hover:bg-slate-100 active:bg-slate-200/80 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:active:bg-[var(--color-studio-dark-active)] dark:focus-visible:ring-offset-[var(--color-studio-dark-floating)]";

export function RuntimeMenuOptionsList({
  options,
  selectedRuntimeId,
  onSelectOption,
  onTerminateRuntime,
  onRemoveRuntime,
  onStartRuntime,
  className = "mt-1 max-h-64 overflow-auto",
  optionClassName = DEFAULT_OPTION_CLASS,
  selectedOptionClassName = "bg-slate-100 font-medium text-slate-900",
  emptyStateMessage = "No runtimes connected.",
  onCopyTunnel,
  copyDisabled = false,
  defaultExpandedOptionId = null,
  renderOptionExtras,
  sparklineVariant = "compact",
}: RuntimeMenuOptionsListProps) {
  const { showStatus } = useStatus();
  const [expandedOptionId, setExpandedOptionId] = useState<string | null>(null);
  const [removeConfirmOptionId, setRemoveConfirmOptionId] = useState<string | null>(null);

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
        <Card
          tone="raised"
          radius="xl"
          shadow="none"
          padding="sm"
          className="py-2 text-xs text-slate-500"
        >
          {emptyStateMessage}
        </Card>
      </div>
    );
  }

  return (
    <div className={className}>
      {options.map((option) => {
        const optionKey = option.id ?? option.label;
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
        const optionClasses = [
          optionClassName,
          isSelected ? selectedOptionClassName : "",
        ]
          .filter(Boolean)
          .join(" ")
          .trim();

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
        const hasActions = hasDetails || canStart || canTerminate || canRemove;

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
            <div className="flex w-full items-start gap-1">
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelectOption(option.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectOption(option.id);
                  }
                }}
                className={optionClasses}
              >
                <span className="flex h-7 flex-none items-center" aria-hidden="true">
                  <RuntimeStateIndicator option={option} />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <RuntimeOptionMeta
                    option={option}
                    showDetail={false}
                    showProviderBadge={false}
                    showRuntimeIdBadge
                    className="flex min-w-0 flex-col gap-0.5"
                  />
                  {resources ? (
                    <Text
                      as="span"
                      variant="caption"
                      tone="muted"
                      className="block break-words pr-1 text-xxs leading-tight"
                      title={resources.title}
                    >
                      {resources.summary}
                    </Text>
                  ) : null}
                </div>
              </div>
              {hasActions ? (
                <IconButton
                  variant="ghost"
                  size="xs"
                  radius="full"
                  className="mt-1 shrink-0 text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50"
                  aria-label={isExpanded ? "Hide runtime details" : "Show runtime details"}
                  aria-expanded={isExpanded}
                  title={isExpanded ? "Hide runtime details" : "Show runtime details"}
                  onPress={toggleDetails}
                >
                  <NavArrowDown
                    className={`h-4 w-4 transition-transform motion-reduce:transition-none ${
                      isExpanded ? "rotate-180" : ""
                    }`}
                    aria-hidden="true"
                  />
                </IconButton>
              ) : null}
            </div>
            {hasActions && isExpanded ? (
              // pl-6 lines the details up under the option label: it clears
              // the state-indicator column (indicator + gap-2) inside the
              // header's px-2.5.
              <div
                className={`mx-2.5 mt-1 flex flex-col gap-2.5 border-t border-slate-200/70 pb-1 pl-6 pt-2.5 text-xs text-slate-600 dark:text-slate-300 ${DARK_DIVIDER_BORDER_CLASS}`}
              >
                {shouldShowDetailText ? (
                  <Text as="p" variant="caption" tone="muted" className="break-words text-xxs">
                    {option.detail}
                  </Text>
                ) : null}
                {isHostedOption ? (
                  <div className="space-y-2" data-testid="runtime-hosted-machine-facts">
                    <Text as="p" variant="caption" tone="muted" className="text-xxs">
                      Node, Python, and browsers preinstalled. Project files and
                      caches survive pauses; everything else resets.
                    </Text>
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
                {runtimeIdValue || runtimeImageValue || shouldShowEndpoint || shouldShowHost || lifecycleRow ? (
                  <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
                    {runtimeIdValue ? (
                      <RuntimeValueRow
                        label="ID"
                        value={runtimeIdValue}
                        displayValue={compactIdentifier(runtimeIdValue)}
                        mono
                        copyLabel="Copy runtime id"
                        copyTestId={option.id ? `runtime-copy-id-${option.id}` : undefined}
                        onCopy={() => {
                          copyWithFeedback(runtimeIdValue, "Runtime id copied");
                        }}
                      />
                    ) : null}
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
                {canStart || canTerminate || canRemove ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {canStart ? (
                      <Button
                        onPress={() => onStartRuntime?.(option.id ?? null)}
                        variant="outline"
                        size="xs"
                        radius="full"
                        className="gap-1.5 text-xxs"
                      >
                        <Play className="h-3.5 w-3.5 text-primary-500" aria-hidden="true" />
                        Start
                      </Button>
                    ) : null}
                    {canTerminate && !canStart ? (
                      <Button
                        onPress={() => onTerminateRuntime?.(option.id ?? null)}
                        variant="outline"
                        size="xs"
                        radius="full"
                        className="gap-1.5 text-xxs"
                      >
                        <Square className="h-3.5 w-3.5 text-secondary-500" aria-hidden="true" />
                        Stop
                      </Button>
                    ) : null}
                    {canRemove && !isConfirmingRemove ? (
                      <Button
                        onPress={() => setRemoveConfirmOptionId(optionKey)}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        className="ml-auto gap-1.5 text-xxs text-rose-700 hover:bg-rose-50 data-[hovered]:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10 dark:data-[hovered]:bg-rose-500/10"
                      >
                        <Trash className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {canRemove && isConfirmingRemove ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200/80 bg-rose-50/50 px-2 py-1.5 dark:border-rose-500/40 dark:bg-rose-500/10">
                    <Text as="span" variant="caption" tone="muted" className="text-xxs">
                      Remove “{option.label}”?
                    </Text>
                    <div className="flex items-center gap-1.5">
                      {/* Focus enters the strip on the safe action, never on
                          the destructive one. */}
                      <Button
                        onPress={() => setRemoveConfirmOptionId(null)}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        autoFocus
                        className="text-xxs"
                      >
                        Cancel
                      </Button>
                      <Button
                        onPress={() => {
                          setRemoveConfirmOptionId(null);
                          onRemoveRuntime?.(option.id ?? null);
                        }}
                        variant="danger"
                        size="xs"
                        radius="full"
                        className="text-xxs"
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
