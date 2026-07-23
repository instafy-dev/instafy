import { useState } from "react";
import { Copy, MoreHoriz, Pause, Play, Trash } from "iconoir-react";
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
  resolveTunnelHostname,
  resolveTunnelUrl,
  RuntimeStateIndicator,
  tunnelGrantIsActive,
  writeClipboardText,
} from "../runtimeMenuShared";
import type { RuntimeMenuOption } from "../useRuntimeMenu";
import type { TunnelCopyMode } from "./RuntimeTunnelDetails";
import { Button, IconButton } from "../../components/Button";
import { Card } from "../../components/Card";
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

function formatRuntimeHealthLabel(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (normalized === "online") return "online";
  if (normalized === "idle") return "idle";
  if (normalized === "offline") return "offline";
  if (normalized === "booting") return "booting";
  return normalized;
}

function formatBytesCompact(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals;
  return `${rounded} ${units[unitIndex]}`;
}

function formatUsagePair(
  used: number | null | undefined,
  limit: number | null | undefined,
): string | null {
  if (typeof used !== "number" || Number.isNaN(used) || used < 0) {
    return null;
  }
  const usedLabel = formatBytesCompact(used);
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return usedLabel;
  }
  return `${usedLabel} / ${formatBytesCompact(limit)}`;
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
  if (typeof resources.cpuPct === "number" && Number.isFinite(resources.cpuPct)) {
    segments.push(
      cpuLimitCores ? `CPU ${Math.round(resources.cpuPct)}% (${cpuLimitCores})` : `CPU ${Math.round(resources.cpuPct)}%`,
    );
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
  tone?: "inherit" | "secondary";
  mono?: boolean;
  copyLabel?: string;
  copyTestId?: string;
  onCopy?: () => void;
}

function RuntimeValueRow({
  label,
  value,
  tone = "secondary",
  mono = false,
  copyLabel = "Copy value",
  copyTestId,
  onCopy,
}: RuntimeValueRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Text
        as="span"
        variant="caption"
        tone="secondary"
        className="shrink-0 whitespace-nowrap text-xxs font-medium"
      >
        {label}:
      </Text>
      <Text
        as="span"
        variant={mono ? "mono" : "caption"}
        tone={tone}
        className="min-w-0 flex-1 truncate text-xxs"
        title={value}
      >
        {value}
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
    </div>
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
}

/**
 * Machine size choice for the hosted runtime. The selection is a per-project
 * preference validated server-side; it applies the next time the machine
 * starts, and a boosted machine burns credits at the shown multiple.
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
      `${choice?.label ?? sizeId} machine (${choice?.specs ?? ""}, ${choice?.costNote ?? ""}) applies the next time this machine starts — stop and start it from this menu to switch now.`,
      "info",
      7000,
      { id: "runtime-size-change" },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="runtime-size-picker">
      <Text as="span" variant="caption" tone="secondary" className="text-xxs font-medium">
        Machine size:
      </Text>
      {RUNTIME_SIZE_CHOICES.map((choice) => {
        const active = choice.id === selected;
        return (
          <button
            key={choice.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              choose(choice.id);
            }}
            data-testid={`runtime-size-${choice.id}`}
            className={[
              "rounded-full border px-2 py-0.5 text-xxs font-medium transition",
              active
                ? "border-primary-400 bg-primary-50 text-primary-700 dark:border-primary-500/60 dark:bg-primary-500/10 dark:text-primary-300"
                : "border-slate-200 text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200",
            ].join(" ")}
            title={`${choice.specs} · ${choice.costNote}`}
          >
            {choice.label} · {choice.specs} · {choice.costNote}
          </button>
        );
      })}
    </div>
  );
}

const DEFAULT_OPTION_CLASS =
  "flex w-full cursor-pointer flex-col gap-2 rounded-xl px-2.5 py-1.5 text-left transition hover:bg-slate-100 active:bg-slate-200/80 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:active:bg-[var(--color-studio-dark-active)] dark:focus-visible:ring-offset-[var(--color-studio-dark-floating)]";

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
}: RuntimeMenuOptionsListProps) {
  const [expandedOptionId, setExpandedOptionId] = useState<string | null>(null);
  const [removeConfirmOptionId, setRemoveConfirmOptionId] = useState<string | null>(null);

  if (options.length === 0) {
    return (
      <div className={className}>
        <Card
          tone="muted"
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
        const isExpanded = expandedOptionId === optionKey;
        const toggleDetails = () => {
          setExpandedOptionId((current) => (current === optionKey ? null : optionKey));
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
        const runtimeHealthValue = formatRuntimeHealthLabel(option.runtimeHealth ?? option.state);
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
        const hasDetails =
          Boolean(runtimeIdValue) ||
          Boolean(runtimeImageValue) ||
          Boolean(runtimeHealthValue) ||
          Boolean(formattedLastSeen) ||
          shouldShowDetailText ||
          shouldShowEndpoint ||
          Boolean(formattedLaunch) ||
          Boolean(resources) ||
          shouldShowHost;
        const canTerminate =
          Boolean(onTerminateRuntime) && Boolean(option.id) && !option.isLikelyLocal;
        const canRemove =
          Boolean(onRemoveRuntime) && Boolean(option.id) && !option.isLikelyLocal;
        const canStart =
          Boolean(onStartRuntime) &&
          Boolean(option.id) &&
          !option.isLikelyLocal &&
          option.state === "offline";
        const canCopyTunnel =
          Boolean(onCopyTunnel) && !copyDisabled && Boolean(option.tunnel) && Boolean(option.id);
        const hasActions = hasDetails || canStart || canTerminate || canRemove || canCopyTunnel;

        return (
          <div
            key={optionKey}
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
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-start gap-2 text-left">
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
                <div
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="mt-0.5"
                >
                  <IconButton
                    variant="ghost"
                    size="xs"
                    radius="full"
                    className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50"
                    aria-label="Runtime actions"
                    aria-expanded={isExpanded}
                    title={isExpanded ? "Hide details" : "Show details"}
                    onPress={toggleDetails}
                  >
                    <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              ) : null}
            </div>
            {hasActions && isExpanded ? (
              <Card tone="muted" radius="xl" shadow="none" padding="sm" className="text-xs text-slate-600">
                {shouldShowDetailText ? (
                  <Text as="p" variant="caption" tone="muted" className="mb-2 break-words text-xxs">
                    {option.detail}
                  </Text>
                ) : null}
                {isHostedOption ? (
                  <div className="mb-2 space-y-1.5" data-testid="runtime-hosted-machine-facts">
                    <Text as="p" variant="caption" tone="muted" className="text-xxs">
                      Hosted machine · Node, Python, browsers. Project files and caches are
                      kept; everything else resets when the machine pauses. For heavy builds,
                      connect your own machine.
                    </Text>
                    <RuntimeSizePickerRow />
                  </div>
                ) : null}
                {resources ? (
                  <div className="mb-2 flex flex-wrap items-center gap-1 text-xxs">
                    <Text
                      as="span"
                      variant="caption"
                      tone="secondary"
                      className="text-xxs font-medium"
                    >
                      Resources:
                    </Text>
                    <Text
                      as="span"
                      variant="caption"
                      tone="muted"
                      className="text-xxs"
                      title={resources.title}
                    >
                      {resources.summary}
                    </Text>
                  </div>
                ) : (
                  <div className="mb-2 flex flex-wrap items-center gap-1 text-xxs">
                    <Text
                      as="span"
                      variant="caption"
                      tone="secondary"
                      className="text-xxs font-medium"
                    >
                      Resources:
                    </Text>
                    <Text as="span" variant="caption" tone="muted" className="text-xxs">
                      Not reported yet
                    </Text>
                  </div>
                )}
                {runtimeIdValue || runtimeImageValue || runtimeHealthValue || formattedLastSeen || shouldShowEndpoint || formattedLaunch ? (
                  <div className="space-y-1.5 text-xxs text-slate-600">
                    {runtimeIdValue ? (
                      <RuntimeValueRow
                        label="Runtime"
                        value={runtimeIdValue}
                        mono
                        copyLabel="Copy runtime id"
                        copyTestId={option.id ? `runtime-copy-id-${option.id}` : undefined}
                        onCopy={() => {
                          void writeClipboardText(runtimeIdValue);
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
                          void writeClipboardText(runtimeImageValue);
                        }}
                      />
                    ) : null}
                    {runtimeHealthValue ? (
                      <RuntimeValueRow
                        label="Health"
                        value={runtimeHealthValue}
                        tone="inherit"
                      />
                    ) : null}
                    {formattedLastSeen ? (
                      <RuntimeValueRow
                        label="Last seen"
                        value={formattedLastSeen}
                        tone="inherit"
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
                          void writeClipboardText(option.endpoint);
                        }}
                      />
                    ) : null}
                    {formattedLaunch ? (
                      <RuntimeValueRow
                        label="Launched"
                        value={formattedLaunch}
                        tone="inherit"
                      />
                    ) : null}
                  </div>
                ) : null}
                {tunnelHost ? (
                  <div className="mt-2">
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
                                void writeClipboardText(tunnelHost);
                              }
                          : undefined
                      }
                    />
                  </div>
                ) : null}
                {canStart || canTerminate || canRemove ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
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
                        <Pause className="h-3.5 w-3.5 text-secondary-500" aria-hidden="true" />
                        Stop
                      </Button>
                    ) : null}
                    {canRemove ? (
                      <Button
                        onPress={() => {
                          if (isConfirmingRemove) {
                            setRemoveConfirmOptionId(null);
                            onRemoveRuntime?.(option.id ?? null);
                            return;
                          }
                          setRemoveConfirmOptionId(optionKey);
                        }}
                        variant="outline"
                        size="xs"
                        radius="full"
                        className="gap-1.5 text-xxs text-rose-700 hover:bg-rose-50 data-[hovered]:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10 dark:data-[hovered]:bg-rose-500/10"
                      >
                        <Trash className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />
                        {isConfirmingRemove ? "Confirm remove" : "Remove"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {canRemove && isConfirmingRemove ? (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-rose-200/80 bg-rose-50/50 px-2 py-1.5 dark:border-rose-500/40 dark:bg-rose-500/10">
                    <Text as="span" variant="caption" tone="muted" className="text-xxs">
                      Remove runtime “{option.label}”?
                    </Text>
                    <Button
                      onPress={() => setRemoveConfirmOptionId(null)}
                      variant="ghost"
                      size="xs"
                      radius="full"
                      className="text-xxs"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
