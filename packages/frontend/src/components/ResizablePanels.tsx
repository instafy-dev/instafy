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
    if (!sideVisible) {
      return [100];
    }
    const clamped = clampRatio(ratio);
    const sidePercent = clamped * 100;
    const mainPercent = 100 - sidePercent;
    return [mainPercent, sidePercent];
  }, [clampRatio, ratio, sideVisible]);

  const handleLayoutChange = useCallback(
    (sizes: number[]) => {
      const sidePercent = sizes[1];
      if (typeof sidePercent !== "number") {
        return;
      }
      const nextRatio = clampRatio(sidePercent / 100);
      if (Math.abs(nextRatio - ratio) > RATIO_EPSILON) {
        onRatioChange(nextRatio);
      }
    },
    [clampRatio, onRatioChange, ratio]
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
      className={`flex h-full gap-4 ${className ?? ""}`}
      onLayout={handleLayoutChange}
    >
      <Panel
        className="overflow-hidden"
        minSize={sideVisible ? mainMin : undefined}
        maxSize={sideVisible ? mainMax : undefined}
        order={1}
      >
        {main}
      </Panel>
      {sideVisible ? (
        <>
          <PanelResizeHandle className="relative w-4 rounded-full bg-slate-200/80 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.12)] transition hover:bg-slate-200 data-[resize-handle-active=true]:bg-slate-200 data-[resize-handle-dragging=true]:bg-slate-200">
            <div className="pointer-events-none absolute left-1/2 top-1/2 hidden h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 shadow-[0_0_4px_rgba(15,23,42,0.3)] lg:block" />
          </PanelResizeHandle>
          <Panel className="overflow-hidden" minSize={sideMin} maxSize={sideMax} order={2}>
            {side}
          </Panel>
        </>
      ) : null}
    </PanelGroup>
  );
}
