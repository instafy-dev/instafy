import { Text } from "../../components/Text";
import { formatCpuPct, formatUsagePair } from "../runtimeMenuShared";
import type { RuntimeResourceSample } from "../runtimeResourceHistory";

/**
 * Compact CPU/RAM trend for one runtime, drawn from the client-side sample
 * history. Each row derives its value label from its OWN series' last point,
 * so a partial heartbeat (memory-only, cpu-only) can never hide a trend or
 * label it with a value from a sample that contributed no point. Identity is
 * carried by the row label and the value text; the line color is a secondary
 * cue. Mark colors are validated data-viz steps of the brand hues against the
 * light (white) and dark (floating #262626) menu surfaces — the sand token
 * itself is too pale to read as a mark, hence the explicit amber steps for
 * RAM. The x-axis is sample-ordered (heartbeat cadence), not time-scaled.
 */

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 18;
const SPARK_PAD_Y = 1.5;

const CPU_STROKE_CLASS = "text-primary-500";
const MEM_STROKE_CLASS = "text-[#a9761f] dark:text-[#b8862f]";
// Disk moves slowly; a neutral mark keeps it legible without competing with
// the live CPU/RAM hues.
const DISK_STROKE_CLASS = "text-slate-400 dark:text-slate-500";

interface MetricSeries {
  key: string;
  label: string;
  strokeClass: string;
  points: number[];
  valueLabel: string;
}

function buildMetrics(history: RuntimeResourceSample[]): MetricSeries[] {
  const cpuPoints: number[] = [];
  const memPoints: number[] = [];
  const diskPoints: number[] = [];
  let lastCpu: number | null = null;
  let lastMemSample: RuntimeResourceSample | null = null;
  let lastDiskSample: RuntimeResourceSample | null = null;
  for (const sample of history) {
    if (sample.cpuPct !== null) {
      cpuPoints.push(sample.cpuPct);
      lastCpu = sample.cpuPct;
    }
    if (sample.memPct !== null) {
      memPoints.push(sample.memPct);
      lastMemSample = sample;
    }
    if (sample.diskPct !== null) {
      diskPoints.push(sample.diskPct);
      lastDiskSample = sample;
    }
  }

  const metrics: MetricSeries[] = [];
  const cpuLabel = formatCpuPct(lastCpu);
  if (cpuPoints.length > 0 && cpuLabel) {
    metrics.push({
      key: "cpu",
      label: "CPU",
      strokeClass: CPU_STROKE_CLASS,
      points: cpuPoints,
      valueLabel: cpuLabel,
    });
  }
  const memLabel = lastMemSample
    ? formatUsagePair(lastMemSample.memUsedBytes, lastMemSample.memLimitBytes)
    : null;
  if (memPoints.length > 0 && memLabel) {
    metrics.push({
      key: "mem",
      label: "RAM",
      strokeClass: MEM_STROKE_CLASS,
      points: memPoints,
      valueLabel: memLabel,
    });
  }
  const diskLabel = lastDiskSample
    ? formatUsagePair(lastDiskSample.diskUsedBytes, lastDiskSample.diskLimitBytes)
    : null;
  if (diskPoints.length > 0 && diskLabel) {
    metrics.push({
      key: "disk",
      label: "Disk",
      strokeClass: DISK_STROKE_CLASS,
      points: diskPoints,
      valueLabel: diskLabel,
    });
  }
  return metrics;
}

function sparkPath(points: number[]): {
  line: string;
  area: string;
  endX: number;
  endY: number;
} {
  const usableHeight = SPARK_HEIGHT - SPARK_PAD_Y * 2;
  const step = points.length > 1 ? SPARK_WIDTH / (points.length - 1) : 0;
  const coords = points.map((pct, index) => {
    const clamped = Math.max(0, Math.min(100, pct));
    return {
      x: points.length > 1 ? index * step : SPARK_WIDTH / 2,
      y: SPARK_HEIGHT - SPARK_PAD_Y - (clamped / 100) * usableHeight,
    };
  });
  const line = coords
    .map((c, index) => `${index === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area =
    coords.length > 1
      ? `${line} L${last.x.toFixed(1)},${SPARK_HEIGHT} L${first.x.toFixed(1)},${SPARK_HEIGHT} Z`
      : "";
  return { line, area, endX: last.x, endY: last.y };
}

function metricTitle(metric: MetricSeries): string {
  const min = Math.min(...metric.points);
  const max = Math.max(...metric.points);
  return `${metric.label} ${metric.valueLabel} · min ${Math.round(min)}% · max ${Math.round(max)}% · ${metric.points.length} sample${metric.points.length === 1 ? "" : "s"}`;
}

interface RuntimeResourceSparklinesProps {
  history: RuntimeResourceSample[];
  /**
   * "compact" keeps the fixed-width mini trend for dense menus; "page"
   * stretches each series to the full row (the Machines page draft) with a
   * taller plot. Strokes stay uniform under the non-uniform stretch via
   * vector-effect; the end dot is dropped there (it would smear into an
   * ellipse, and the line's end is obvious at full width).
   */
  variant?: "compact" | "page";
}

export function RuntimeResourceSparklines({
  history,
  variant = "compact",
}: RuntimeResourceSparklinesProps) {
  const metrics = buildMetrics(history);
  if (metrics.length === 0) {
    return null;
  }
  const isPage = variant === "page";

  return (
    <div className={isPage ? "space-y-1.5" : "space-y-1"} data-testid="runtime-resource-sparklines">
      {metrics.map((metric) => {
        const { line, area, endX, endY } = sparkPath(metric.points);
        return (
          <div
            key={metric.key}
            // Page rows share the facts grid's label column (3.5rem + gap-3)
            // so plots and values sit on the same content edge.
            className={`flex min-w-0 items-center ${isPage ? "gap-3" : "gap-2"}`}
            title={metricTitle(metric)}
            data-testid={`runtime-sparkline-${metric.key}`}
          >
            <Text
              as="span"
              variant="caption"
              tone="muted"
              className={`${isPage ? "w-14" : "w-7"} shrink-0 text-xxs`}
            >
              {metric.label}
            </Text>
            <svg
              {...(isPage
                ? { preserveAspectRatio: "none" }
                : { width: SPARK_WIDTH, height: SPARK_HEIGHT })}
              viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
              // The faint track keeps an idle plot (line hugging the bottom at
              // ~0%) reading as a chart instead of empty space; 28px matches
              // the Size row's height for a uniform row pitch.
              className={`${
                isPage
                  ? "h-7 min-w-0 flex-1 rounded-md bg-slate-500/[0.06] dark:bg-white/[0.04]"
                  : "shrink-0"
              } ${metric.strokeClass}`}
              aria-hidden="true"
            >
              {area ? <path d={area} fill="currentColor" opacity="0.12" /> : null}
              {metric.points.length > 1 ? (
                <path
                  d={line}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  {...(isPage ? { vectorEffect: "non-scaling-stroke" } : {})}
                />
              ) : null}
              {!isPage ? <circle cx={endX} cy={endY} r="2" fill="currentColor" /> : null}
            </svg>
            <Text
              as="span"
              variant="caption"
              tone="secondary"
              className={`${isPage ? "w-24 shrink-0" : "min-w-0 flex-1"} truncate text-right text-xxs tabular-nums`}
            >
              {metric.valueLabel}
            </Text>
          </div>
        );
      })}
    </div>
  );
}
