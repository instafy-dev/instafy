import type { CreditLedgerEntry } from "../../../credits/creditService";
import { LIVE_ACCESS_SINGULAR } from "../../../credits/usageLabels";

type AmountMode = "units" | "usd";
export type CreditActivityRange = "7d" | "30d";
type ActivityCategory = "ai" | "runtime" | "tunnel" | "other" | "refill" | "neutral";

type TimelineSegment = {
  startTs: number;
  endTs: number;
  balance: number;
  category: ActivityCategory;
};

type TimelineMarker = {
  ts: number;
  dayKey: string;
  dayLabel: string;
  label: string;
  balanceBefore: number;
  balanceAfter: number;
  category: Exclude<ActivityCategory, "neutral">;
  delta: number;
  reason: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_WINDOW_MS: Record<CreditActivityRange, number> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

const COLORS: Record<Exclude<ActivityCategory, "neutral">, string> = {
  ai: "#2563eb",
  runtime: "#7c3aed",
  tunnel: "#ea580c",
  other: "#64748b",
  refill: "#16a34a",
};

function rawReasonCategory(reason: string): Exclude<ActivityCategory, "neutral"> {
  switch (reason.trim()) {
    case "managed_ai_prompt":
    case "managed_ai_adjustment":
    case "managed_ai_refund":
      return "ai";
    case "hosted_runtime":
      return "runtime";
    case "tunnel_grant":
      return "tunnel";
    case "auto_refill_daily":
    case "sandbox_seed":
      return "refill";
    default:
      return "other";
  }
}

function ledgerCategory(entry: Pick<CreditLedgerEntry, "delta" | "reason">): Exclude<ActivityCategory, "neutral"> {
  const category = rawReasonCategory(entry.reason);
  if (entry.delta >= 0) {
    return "refill";
  }
  return category;
}

function convertAmount(units: number, mode: AmountMode, unitsPerUsd: number): number {
  if (mode === "usd" && unitsPerUsd > 0) {
    return units / unitsPerUsd;
  }
  return units;
}

function formatAmount(value: number, mode: AmountMode, unitLabel: string, currency: string): string {
  if (mode === "usd") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: value >= 10 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} ${unitLabel}`;
}

function formatMarkerLabel(date: Date, range: CreditActivityRange, sameDayActivity: boolean): string {
  if (range === "7d" && sameDayActivity) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (range === "7d") {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildTimeline(
  entries: CreditLedgerEntry[],
  currentBalanceUnits: number,
  balanceLimitUnits: number,
  mode: AmountMode,
  unitsPerUsd: number,
  range: CreditActivityRange,
): { segments: TimelineSegment[]; markers: TimelineMarker[]; maxBalance: number } | null {
  const sorted = [...entries]
    .map((entry) => ({ entry, ts: Date.parse(entry.createdAt) }))
    .filter((item) => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts);

  if (sorted.length === 0) {
    return null;
  }

  const latestTs = sorted[sorted.length - 1]?.ts ?? Date.now();
  const windowEnd = Math.max(Date.now(), latestTs);
  const windowStart = windowEnd - LOOKBACK_WINDOW_MS[range];
  const initialBalanceUnits = currentBalanceUnits - sorted.reduce((total, item) => total + item.entry.delta, 0);
  const visibleItems = sorted.filter((item) => item.ts >= windowStart);
  const sameDayActivity =
    visibleItems.length > 1 &&
    new Date(visibleItems[0]!.ts).toDateString() ===
      new Date(visibleItems[visibleItems.length - 1]!.ts).toDateString();

  let runningBalanceUnits = initialBalanceUnits;
  let cursorTs = windowStart;
  let activeCategory: ActivityCategory = "neutral";
  const segments: TimelineSegment[] = [];
  const markers: TimelineMarker[] = [];

  for (const item of sorted) {
    if (item.ts < windowStart) {
      runningBalanceUnits += item.entry.delta;
      activeCategory = ledgerCategory(item.entry);
      continue;
    }

    if (item.ts > cursorTs) {
      segments.push({
        startTs: cursorTs,
        endTs: item.ts,
        balance: convertAmount(runningBalanceUnits, mode, unitsPerUsd),
        category: activeCategory,
      });
    }

    const nextBalanceUnits = runningBalanceUnits + item.entry.delta;
    const category = ledgerCategory(item.entry);
    const date = new Date(item.ts);

    markers.push({
      ts: item.ts,
      dayKey: date.toISOString().slice(0, 10),
      dayLabel: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      label: formatMarkerLabel(date, range, sameDayActivity),
      balanceBefore: convertAmount(runningBalanceUnits, mode, unitsPerUsd),
      balanceAfter: convertAmount(nextBalanceUnits, mode, unitsPerUsd),
      category,
      delta: convertAmount(item.entry.delta, mode, unitsPerUsd),
      reason: item.entry.reason,
    });

    runningBalanceUnits = nextBalanceUnits;
    activeCategory = category;
    cursorTs = item.ts;
  }

  if (cursorTs < windowEnd) {
    segments.push({
      startTs: cursorTs,
      endTs: windowEnd,
      balance: convertAmount(runningBalanceUnits, mode, unitsPerUsd),
      category: activeCategory,
    });
  }

  const balances = [
    convertAmount(currentBalanceUnits, mode, unitsPerUsd),
    convertAmount(balanceLimitUnits, mode, unitsPerUsd),
    ...segments.map((segment) => segment.balance),
    ...markers.flatMap((marker) => [marker.balanceBefore, marker.balanceAfter]),
  ];
  const maxBalance = Math.max(1, ...balances);

  return { segments, markers, maxBalance };
}

function formatDelta(delta: number, mode: AmountMode, unitLabel: string, currency: string) {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatAmount(delta, mode, unitLabel, currency)}`;
}

function clampLabelMarkers(
  markers: TimelineMarker[],
  xForTs: (ts: number) => number,
  groupByDay: boolean,
  minGap = 56,
): TimelineMarker[] {
  const ordered = (
    groupByDay
      ? [...new Map(markers.map((marker) => [marker.dayKey, marker])).values()]
      : [...markers]
  ).sort((a, b) => a.ts - b.ts);
  const kept: TimelineMarker[] = [];
  let lastX = Number.POSITIVE_INFINITY;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const marker = ordered[index]!;
    const x = xForTs(marker.ts);
    if (lastX - x < minGap) {
      continue;
    }
    kept.push(marker);
    lastX = x;
  }

  return kept.reverse();
}

export function CreditActivityChart({
  entries,
  amountMode,
  unitLabel,
  currency,
  unitsPerUsd,
  currentBalance,
  balanceLimit,
  range,
}: {
  entries: CreditLedgerEntry[];
  amountMode: AmountMode;
  unitLabel: string;
  currency: string;
  unitsPerUsd: number;
  currentBalance: number;
  balanceLimit: number;
  range: CreditActivityRange;
}) {
  const timeline = buildTimeline(entries, currentBalance, balanceLimit, amountMode, unitsPerUsd, range);

  if (!timeline || timeline.segments.length === 0) {
    return (
      <div
        className="rounded-2xl border border-dashed border-slate-300/80 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
        data-testid="credit-activity-graph-empty"
      >
        No activity yet to graph.
      </div>
    );
  }

  const chartWidth = 720;
  const chartHeight = 212;
  const insetLeft = 20;
  const insetRight = 20;
  const insetTop = 18;
  const insetBottom = 30;
  const plotWidth = chartWidth - insetLeft - insetRight;
  const plotHeight = chartHeight - insetTop - insetBottom;
  const baselineY = insetTop + plotHeight;
  const markerStartTs = timeline.markers[0]?.ts ?? timeline.segments[0]?.startTs ?? Date.now();
  const markerEndTs =
    timeline.markers[timeline.markers.length - 1]?.ts ??
    timeline.segments[timeline.segments.length - 1]?.endTs ??
    Date.now();
  const eventSpan = Math.max(1, markerEndTs - markerStartTs);
  const minDomainSpan = range === "7d" ? 18 * 60 * 60 * 1000 : 7 * DAY_MS;
  const sidePadding = Math.min(
    range === "7d" ? 6 * 60 * 60 * 1000 : 2 * DAY_MS,
    Math.max(range === "7d" ? 2 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000, eventSpan * 0.18),
  );
  const domainStart = Math.max(
    timeline.segments[0]?.startTs ?? markerStartTs,
    markerEndTs - Math.max(minDomainSpan, eventSpan + sidePadding * 2),
  );
  const domainEnd = Math.max(
    timeline.segments[timeline.segments.length - 1]?.endTs ?? markerEndTs,
    domainStart + Math.max(minDomainSpan, eventSpan + sidePadding * 2),
  );
  const minTs = domainStart;
  const maxTs = domainEnd;
  const tsRange = Math.max(1, maxTs - minTs);
  const xForTs = (ts: number) => insetLeft + ((ts - minTs) / tsRange) * plotWidth;
  const yForBalance = (balance: number) => {
    const ratio = Math.max(0, Math.min(1, balance / timeline.maxBalance));
    return baselineY - ratio * plotHeight;
  };

  const stepParts: string[] = [];
  const firstSegment = timeline.segments[0]!;
  stepParts.push(`M ${xForTs(firstSegment.startTs)} ${yForBalance(firstSegment.balance)}`);
  timeline.segments.forEach((segment, index) => {
    stepParts.push(`H ${xForTs(segment.endTs)}`);
    const next = timeline.segments[index + 1];
    if (next && next.balance !== segment.balance) {
      stepParts.push(`V ${yForBalance(next.balance)}`);
    }
  });
  const linePath = stepParts.join(" ");
  const areaPath = `${linePath} L ${xForTs(maxTs)} ${baselineY} L ${xForTs(minTs)} ${baselineY} Z`;
  const labelMarkers = clampLabelMarkers(timeline.markers, xForTs, range !== "7d");

  return (
    <div className="space-y-3" data-testid="credit-activity-graph">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.ai }} />
          AI
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.runtime }} />
          Hosted runtime
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.tunnel }} />
          {LIVE_ACCESS_SINGULAR}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.other }} />
          Other burn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS.refill }} />
          Refill
        </span>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="h-[212px] min-w-[640px] w-full text-slate-900 dark:text-slate-100"
          role="img"
          aria-label="Credit balance history graph"
          data-testid="credit-activity-graph-svg"
        >
          <line
            x1={insetLeft}
            y1={baselineY + 0.5}
            x2={chartWidth - insetRight}
            y2={baselineY + 0.5}
            stroke="currentColor"
            opacity={0.14}
          />
          <line
            x1={insetLeft}
            y1={insetTop + 0.5}
            x2={chartWidth - insetRight}
            y2={insetTop + 0.5}
            stroke="currentColor"
            opacity={0.05}
          />

          <path d={areaPath} fill="currentColor" opacity={0.035} />

          {timeline.markers.map((marker, index) => {
            const cx = xForTs(marker.ts);
            const cy = yForBalance(marker.balanceAfter);
            return (
              <g key={`${marker.ts}-${marker.reason}-${index}`}>
                <title>
                  {marker.dayLabel}: {formatDelta(marker.delta, amountMode, unitLabel, currency)} · balance{" "}
                  {formatAmount(marker.balanceAfter, amountMode, unitLabel, currency)}
                </title>
                <rect
                  x={cx - 7}
                  y={cy}
                  width={14}
                  height={Math.max(6, baselineY - cy)}
                  rx={7}
                  fill={COLORS[marker.category]}
                  opacity={0.14}
                />
                <circle cx={cx} cy={cy} r={5} fill="white" opacity={0.95} />
                <circle cx={cx} cy={cy} r={3.25} fill={COLORS[marker.category]} />
              </g>
            );
          })}

          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            data-testid="credit-balance-line"
          />

          {labelMarkers.map((marker) => (
            <text
              key={`${marker.dayKey}-${marker.ts}`}
              x={xForTs(marker.ts)}
              y={chartHeight - 8}
              textAnchor="middle"
              className="fill-slate-500 text-xxs dark:fill-slate-400"
            >
              {marker.label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
