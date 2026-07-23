import {
  type CSSProperties,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type ThreadSpineTone = "neutral" | "primary" | "warning" | "danger";

export type ThreadSpineSegment = {
  topPx?: number;
  bottomPx?: number;
  heightPx?: number;
};

export type ThreadSpineNotch = {
  offsetPx?: number;
  maskLine?: boolean;
};

const WARNING_SPINE_COLOR = "#facc15";
const THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX = 9;
const THREAD_SPINE_NOTCH_HEIGHT_PX = 8;
const THREAD_SPINE_VIEWBOX_WIDTH_PX = 18;
const THREAD_SPINE_STEM_CENTER_X = 2.5;

function resolveThreadSpineSegmentBounds(
  segment: ThreadSpineSegment,
  heightPx: number,
): { startPx: number; endPx: number } | null {
  const startPx = Math.max(0, segment.topPx ?? 0);
  let endPx: number;
  if (segment.heightPx !== undefined) {
    endPx = startPx + segment.heightPx;
  } else if (segment.bottomPx !== undefined) {
    endPx = heightPx - segment.bottomPx;
  } else {
    endPx = heightPx;
  }
  const clampedEndPx = Math.min(heightPx, Math.max(startPx, endPx));
  if (clampedEndPx <= startPx) {
    return null;
  }
  return { startPx, endPx: clampedEndPx };
}

function buildThreadSpinePaths({
  heightPx,
  segments,
  notches,
  stemCenterX,
  curvePeakX,
  junctionOverlapPx,
}: {
  heightPx: number;
  segments: ThreadSpineSegment[];
  notches: ThreadSpineNotch[];
  stemCenterX: number;
  curvePeakX: number;
  junctionOverlapPx: number;
}): { linePathData: string; maskPathData: string } {
  if (heightPx <= 0) {
    return { linePathData: "", maskPathData: "" };
  }

  const sortedNotches = [...notches].sort(
    (left, right) =>
      (left.offsetPx ?? THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX) -
      (right.offsetPx ?? THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX),
  );

  const lineCommands: string[] = [];
  const maskCommands: string[] = [];

  for (const segment of segments) {
    const bounds = resolveThreadSpineSegmentBounds(segment, heightPx);
    if (!bounds) {
      continue;
    }

    lineCommands.push(`M ${stemCenterX} ${bounds.startPx}`);
    let currentY = bounds.startPx;
    for (const notch of sortedNotches) {
      const offsetPx = notch.offsetPx ?? THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX;
      const notchStartPx = offsetPx - junctionOverlapPx;
      const notchEndPx = offsetPx + THREAD_SPINE_NOTCH_HEIGHT_PX + junctionOverlapPx;
      if (notchEndPx <= bounds.startPx || notchStartPx >= bounds.endPx) {
        continue;
      }

      const detourStartPx = Math.max(bounds.startPx, notchStartPx);
      const detourEndPx = Math.min(bounds.endPx, notchEndPx);
      if (detourStartPx > currentY) {
        lineCommands.push(`L ${stemCenterX} ${detourStartPx}`);
      }

      if (notch.maskLine) {
        maskCommands.push(`M ${stemCenterX} ${detourStartPx}`, `L ${stemCenterX} ${detourEndPx}`);
      }

      const detourHeight = detourEndPx - detourStartPx;
      const midpointY = (detourStartPx + detourEndPx) / 2;
      const shoulderOffsetY = Math.max(1.2, detourHeight * 0.2);
      const controlNearStemX = stemCenterX + 1.15;
      const controlFarX = curvePeakX - 0.45;
      lineCommands.push(
        `C ${controlNearStemX} ${detourStartPx + shoulderOffsetY}, ${controlFarX} ${midpointY - shoulderOffsetY}, ${curvePeakX} ${midpointY}`,
        `C ${controlFarX} ${midpointY + shoulderOffsetY}, ${controlNearStemX} ${detourEndPx - shoulderOffsetY}, ${stemCenterX} ${detourEndPx}`,
      );
      currentY = detourEndPx;
    }

    if (currentY < bounds.endPx) {
      lineCommands.push(`L ${stemCenterX} ${bounds.endPx}`);
    }
  }

  return {
    linePathData: lineCommands.join(" "),
    maskPathData: maskCommands.join(" "),
  };
}

export function resolveSpineToneFromStatus(status: string | null): ThreadSpineTone | null {
  if (!status) {
    return null;
  }
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("cancel") ||
    normalized.includes("abort") ||
    normalized.includes("timeout")
  ) {
    return "danger";
  }
  if (normalized.includes("warn") || normalized.includes("degrad") || normalized.includes("partial")) {
    return "warning";
  }
  return null;
}

export function ThreadSpine({
  active = false,
  tone,
  className,
  segments,
  notches,
  style,
  testId = "thread-spine",
}: {
  active?: boolean;
  tone?: ThreadSpineTone;
  className?: string;
  segments?: ThreadSpineSegment[];
  notches?: ThreadSpineNotch[];
  style?: CSSProperties;
  testId?: string;
}) {
  const resolvedTone = tone ?? (active ? "primary" : "neutral");
  const isWarningTone = resolvedTone === "warning";
  const strokeToneClass =
    resolvedTone === "primary"
      ? "text-primary-500 dark:text-primary-400"
      : resolvedTone === "warning"
        ? ""
        : resolvedTone === "danger"
          ? "text-rose-500 dark:text-rose-400"
          : "text-slate-300 dark:text-slate-700";
  const stemWidthPx = isWarningTone ? 1.25 : 1;
  const maskStrokeWidthPx = isWarningTone ? 3.8 : 3.4;
  const junctionStrokeColor = isWarningTone ? WARNING_SPINE_COLOR : "currentColor";
  const junctionOverlapPx = isWarningTone ? 1.2 : 1;
  const curvePeakX = isWarningTone ? 8.2 : 7.6;
  const outerClassName = className ?? "relative w-4 shrink-0";
  const innerClassName = className ? "relative h-full w-4 shrink-0" : "relative w-4 shrink-0";
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [heightPx, setHeightPx] = useState(0);

  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      setHeightPx((current) => (current === nextHeight ? current : nextHeight));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { linePathData, maskPathData } = useMemo(
    () => {
      const resolvedSegments = segments ?? [{ topPx: 0, bottomPx: 0 }];
      const resolvedNotches = notches ?? [];
      return (
      buildThreadSpinePaths({
        heightPx,
        segments: resolvedSegments,
        notches: resolvedNotches,
        stemCenterX: THREAD_SPINE_STEM_CENTER_X,
        curvePeakX,
        junctionOverlapPx,
      })
      );
    },
    [curvePeakX, heightPx, junctionOverlapPx, notches, segments],
  );

  return (
    <div aria-hidden="true" data-testid={testId} className={outerClassName} style={style}>
      <div ref={innerRef} className={innerClassName}>
        {heightPx > 0 ? (
          <svg
            className={`absolute inset-0 h-full w-4 overflow-visible ${strokeToneClass}`}
            viewBox={`0 0 ${THREAD_SPINE_VIEWBOX_WIDTH_PX} ${heightPx}`}
            preserveAspectRatio="none"
            fill="none"
          >
            {maskPathData ? (
              <path
                d={maskPathData}
                className="stroke-white dark:stroke-slate-950"
                strokeWidth={maskStrokeWidthPx}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <path
              d={linePathData}
              stroke={junctionStrokeColor}
              strokeWidth={stemWidthPx}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : null}
      </div>
    </div>
  );
}
