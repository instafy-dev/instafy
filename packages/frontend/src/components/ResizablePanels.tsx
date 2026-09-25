import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle
} from "react-resizable-panels";

interface ResizablePanelsProps {
  main: ReactNode;
  side: ReactNode;
  sideVisible: boolean;
  /** Conversation views stay mounted when a narrow layout shows one pane. */
  mode?: "split" | "main" | "side";
  ratio: number;
  minRatio?: number;
  maxRatio?: number;
  onRatioChange: (ratio: number) => void;
  className?: string;
}

const RATIO_EPSILON = 0.001;

export function ResizablePanels({
  main,
  side,
  sideVisible,
  mode,
  ratio,
  minRatio = 0.2,
  maxRatio = 0.6,
  onRatioChange,
  className
}: ResizablePanelsProps) {
  const clampRatio = useCallback(
    (value: number) => Math.min(maxRatio, Math.max(minRatio, value)),
    [maxRatio, minRatio]
  );

  const layout = useMemo(() => {
    if (mode === "main") return [100, 0];
    if (mode === "side") return [0, 100];
    if (!sideVisible) {
      return [100];
    }
    const clamped = clampRatio(ratio);
    const sidePercent = clamped * 100;
    const mainPercent = 100 - sidePercent;
    return [mainPercent, sidePercent];
  }, [clampRatio, mode, ratio, sideVisible]);

  const handleLayoutChange = useCallback(
    (sizes: number[]) => {
      if (mode && mode !== "split") return;
      const sidePercent = sizes[1];
      if (typeof sidePercent !== "number") {
        return;
      }
      const nextRatio = clampRatio(sidePercent / 100);
      if (Math.abs(nextRatio - ratio) > RATIO_EPSILON) {
        onRatioChange(nextRatio);
      }
    },
    [clampRatio, mode, onRatioChange, ratio]
  );

  const groupRef = useRef<ImperativePanelGroupHandle | null>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) {
      return;
    }
    const currentLayout = group.getLayout();
    const hasDifference =
      currentLayout.length !== layout.length ||
      currentLayout.some((value, index) => Math.abs(value - layout[index]) > 0.5);
    if (hasDifference) {
      group.setLayout(layout);
    }
  }, [layout]);

  const mainMin = Math.max(0, (1 - maxRatio) * 100);
  const mainMax = Math.min(100, (1 - minRatio) * 100);
  const sideMin = minRatio * 100;
  const sideMax = maxRatio * 100;

  return (
    <PanelGroup
      ref={groupRef}
      direction="horizontal"
      className={`flex h-full ${mode ? "" : "gap-4"} ${className ?? ""}`}
      onLayout={handleLayoutChange}
    >
      <Panel
        className="overflow-hidden"
        defaultSize={layout[0]}
        minSize={mode && mode !== "split" ? 0 : sideVisible ? mainMin : undefined}
        maxSize={mode && mode !== "split" ? 100 : sideVisible ? mainMax : undefined}
        order={1}
      >
        <div className="h-full min-w-0" hidden={mode === "side"}>{main}</div>
      </Panel>
      {sideVisible || mode ? (
        <>
          <PanelResizeHandle
            disabled={Boolean(mode && mode !== "split")}
            className={mode ? (mode === "split" ? "relative w-px bg-slate-200 dark:bg-slate-800 after:absolute after:-inset-x-1 after:inset-y-0 hover:bg-primary-500 focus-visible:bg-primary-500 focus-visible:outline-none" : "hidden") : "relative w-4 rounded-full bg-slate-200/80 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.12)] transition hover:bg-slate-200 data-[resize-handle-active=true]:bg-slate-200 data-[resize-handle-dragging=true]:bg-slate-200"}
          >
            {!mode ? (
            <div className="pointer-events-none absolute left-1/2 top-1/2 hidden h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 shadow-[0_0_4px_rgba(15,23,42,0.3)] lg:block" />
            ) : null}
          </PanelResizeHandle>
          <Panel className="overflow-hidden" defaultSize={layout[1]} minSize={mode && mode !== "split" ? 0 : sideMin} maxSize={mode && mode !== "split" ? 100 : sideMax} order={2}>
            <div className="h-full min-w-0" hidden={mode === "main"}>{side}</div>
          </Panel>
        </>
      ) : null}
    </PanelGroup>
  );
}
