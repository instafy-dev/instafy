import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { DARK_DIVIDER_CLASS } from "../theme/darkSurfaces";

interface ResizablePanelsProps {
  main: ReactNode;
  side: ReactNode;
  /** Both panes stay mounted when a narrow layout shows only one. */
  mode: "split" | "main" | "side";
  ratio: number;
  minRatio: number;
  maxRatio: number;
  onRatioChange: (ratio: number) => void;
  onRatioPreview: (ratio: number) => void;
}

export function ResizablePanels({ main, side, mode, ratio, minRatio, maxRatio, onRatioChange, onRatioPreview }: ResizablePanelsProps) {
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null);
  const dragging = useRef(false);
  const latestRatio = useRef(ratio);
  const split = mode === "split";
  const clamp = useCallback((value: number) => Math.min(maxRatio, Math.max(minRatio, value)), [minRatio, maxRatio]);
  const layout = useMemo(() => mode === "main" ? [100, 0] : mode === "side" ? [0, 100] : [(1 - clamp(ratio)) * 100, clamp(ratio) * 100], [mode, ratio, clamp]);

  useEffect(() => {
    latestRatio.current = ratio;
    onRatioPreview(ratio);
    const group = groupRef.current;
    if (!group || dragging.current) return;
    if (group.getLayout().some((value, index) => Math.abs(value - layout[index]) > 0.5)) group.setLayout(layout);
  }, [layout, ratio, onRatioPreview]);

  const handleLayout = useCallback((sizes: number[]) => {
    if (!split || typeof sizes[1] !== "number") return;
    const next = clamp(sizes[1] / 100);
    latestRatio.current = next;
    onRatioPreview(next);
    // Let the panel library and CSS preview the drag. Persist once on release;
    // keyboard resizing commits immediately because it has no drag lifecycle.
    if (!dragging.current && Math.abs(next - ratio) > 0.001) onRatioChange(next);
  }, [split, clamp, onRatioPreview, onRatioChange, ratio]);

  return <PanelGroup ref={groupRef} direction="horizontal" className="flex h-full" onLayout={handleLayout}>
    <Panel className="overflow-hidden" defaultSize={layout[0]} minSize={split ? (1 - maxRatio) * 100 : 0} maxSize={split ? (1 - minRatio) * 100 : 100} order={1}>
      <div className="h-full min-w-0" hidden={mode === "side"}>{main}</div>
    </Panel>
    <PanelResizeHandle
      disabled={!split}
      onDragging={active => {
        dragging.current = active;
        if (!active && split && Math.abs(latestRatio.current - ratio) > 0.001) onRatioChange(latestRatio.current);
      }}
      className={split ? `relative w-px bg-slate-200 ${DARK_DIVIDER_CLASS} after:absolute after:-inset-x-1 after:inset-y-0 hover:bg-primary-500 focus-visible:bg-primary-500 focus-visible:outline-none` : "hidden"}
    />
    <Panel className="overflow-hidden" defaultSize={layout[1]} minSize={split ? minRatio * 100 : 0} maxSize={split ? maxRatio * 100 : 100} order={2}>
      <div className="h-full min-w-0" hidden={mode === "main"}>{side}</div>
    </Panel>
  </PanelGroup>;
}
