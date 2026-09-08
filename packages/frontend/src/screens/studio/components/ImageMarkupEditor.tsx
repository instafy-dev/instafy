import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "../../../components/Button";

const MAX_EDGE = 2048;
const MAX_STROKES = 64;
const MAX_POINTS = 512;
const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
const MARKER_COLOR = "#ef4444";
type Point = { x: number; y: number };
type Tool = "pen" | "arrow";
type Stroke = { tool: Tool; points: Point[] };

export interface ImageMarkupEditorProps {
  src: string;
  alt: string;
  onSave: (blob: Blob) => void | Promise<void>;
  onCancel: () => void;
  saveLabel?: string;
  maxExportBytes?: number;
  onSavingChange?: (saving: boolean) => void;
  canvasTestId?: string;
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, width: number) {
  const first = stroke.points[0];
  if (!first) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  if (stroke.tool === "pen") {
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    if (stroke.points.length === 1) context.lineTo(first.x + 0.01, first.y + 0.01);
  } else {
    const last = stroke.points[stroke.points.length - 1];
    context.lineTo(last.x, last.y);
    const length = Math.hypot(last.x - first.x, last.y - first.y);
    if (length > 0) {
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const head = Math.min(length * 0.45, width * 4);
      for (const direction of [-1, 1]) {
        context.moveTo(last.x, last.y);
        context.lineTo(last.x - head * Math.cos(angle + direction * Math.PI / 6), last.y - head * Math.sin(angle + direction * Math.PI / 6));
      }
    }
  }
  context.stroke();
}

function formatExportLimit(bytes: number) {
  return bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB` : `${bytes} bytes`;
}

async function exportPng(canvas: HTMLCanvasElement, maxBytes: number, isCurrent: () => boolean) {
  let output = canvas;
  let temporary: HTMLCanvasElement | null = null;
  try {
    // PNG can be larger than its JPEG source. Bound both memory and attachment size.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const blob = await new Promise<Blob>((resolve, reject) => {
        output.toBlob((result) => result ? resolve(result) : reject(new Error("PNG export failed.")), "image/png");
      });
      if (!isCurrent()) return null;
      if (blob.size <= maxBytes) return { blob, width: output.width, height: output.height };
      const width = Math.max(1, Math.floor(output.width * 0.75));
      const height = Math.max(1, Math.floor(output.height * 0.75));
      temporary ??= document.createElement("canvas");
      temporary.width = width;
      temporary.height = height;
      const context = temporary.getContext("2d");
      if (!context) throw new Error("Unable to optimize the PNG image.");
      context.drawImage(canvas, 0, 0, width, height);
      output = temporary;
    }
    throw new Error(`Unable to fit the markup within the ${formatExportLimit(maxBytes)} image limit.`);
  } finally {
    if (temporary) { temporary.width = 1; temporary.height = 1; }
  }
}

// A source change starts a new editing session, including pending image/export work.
export function ImageMarkupEditor(props: ImageMarkupEditorProps) {
  return <ImageMarkupEditorSession key={props.src} {...props} />;
}

function ImageMarkupEditorSession({
  src, alt, onSave, onCancel, saveLabel = "Save markup", onSavingChange,
  canvasTestId = "image-markup-canvas", maxExportBytes = MAX_EXPORT_BYTES,
}: ImageMarkupEditorProps) {
  const exportLimit = Number.isFinite(maxExportBytes) && maxExportBytes > 0 ? Math.min(MAX_EXPORT_BYTES, Math.max(1, Math.floor(maxExportBytes))) : MAX_EXPORT_BYTES;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<{ pointerId: number; stroke: Stroke } | null>(null);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const savingChangeRef = useRef(onSavingChange);
  savingChangeRef.current = onSavingChange;
  const [size, setSize] = useState<{ width: number; height: number; optimized: boolean } | null>(null);
  const [exportSize, setExportSize] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [strokeCount, setStrokeCount] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();

  const paint = () => {
    const canvas = canvasRef.current;
    const base = baseCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !base || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(base, 0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = MARKER_COLOR;
    context.lineWidth = Math.max(3, Math.max(canvas.width, canvas.height) / 200);
    for (const stroke of strokesRef.current) drawStroke(context, stroke, context.lineWidth);
    if (activeRef.current) drawStroke(context, activeRef.current.stroke, context.lineWidth);
  };
  const schedulePaint = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      paint();
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    const image = new Image();
    const editorCanvas = canvasRef.current;
    image.onload = () => {
      if (!mountedRef.current) return;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const canvas = canvasRef.current;
      if (!width || !height || !canvas?.getContext("2d")) {
        setError("Unable to prepare the image for drawing.");
        return;
      }
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const base = document.createElement("canvas");
      base.width = canvas.width;
      base.height = canvas.height;
      const baseContext = base.getContext("2d");
      if (!baseContext) {
        base.width = 1;
        base.height = 1;
        setError("Unable to prepare the image for drawing.");
        return;
      }
      // Freeze one frame (including animated images) and scale the source only once.
      baseContext.drawImage(image, 0, 0, base.width, base.height);
      baseCanvasRef.current = base;
      canvas.getContext("2d")!.drawImage(base, 0, 0, canvas.width, canvas.height);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      setSize({ width: canvas.width, height: canvas.height, optimized: scale < 1 });
    };
    image.onerror = () => {
      if (mountedRef.current) setError("Unable to load this image for drawing.");
    };
    image.src = src;
    return () => {
      mountedRef.current = false;
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      const base = baseCanvasRef.current;
      if (base) { base.width = 1; base.height = 1; }
      baseCanvasRef.current = null;
      if (editorCanvas) { editorCanvas.width = 1; editorCanvas.height = 1; }
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (savingRef.current) savingChangeRef.current?.(false);
    };
  }, [src]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
    };
  };
  const addPoint = (point: Point) => {
    const stroke = activeRef.current?.stroke;
    if (!stroke) return;
    if (stroke.tool === "arrow") {
      stroke.points[1] = point;
    } else {
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < 0.5) return;
      // Keep a long gesture responsive without retaining an unbounded pointer stream.
      if (stroke.points.length >= MAX_POINTS) stroke.points = stroke.points.filter((_, index) => index % 2 === 0);
      stroke.points.push(point);
    }
  };
  const endStroke = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const active = activeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!cancelled) {
      const point = pointFromEvent(event);
      if (point) addPoint(point);
      strokesRef.current.push(active.stroke);
      setStrokeCount(strokesRef.current.length);
    }
    activeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrawing(false);
    schedulePaint();
  };
  const handleSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !size || savingRef.current || activeRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    savingChangeRef.current?.(true);
    try {
      // Flush the last pointer frame before taking the immutable PNG snapshot.
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      paint();
      const result = await exportPng(canvas, exportLimit, () => mountedRef.current);
      if (!result) return;
      setExportSize({ width: result.width, height: result.height });
      await onSave(result.blob);
    } catch (cause) {
      if (mountedRef.current) setError(`Unable to save markup. ${cause instanceof Error ? cause.message : "Please try again."}`);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) {
        setSaving(false);
        savingChangeRef.current?.(false);
      }
    }
  };
  const busy = saving || drawing;
  const outputSize = exportSize ?? size;
  const optimized = size?.optimized || (exportSize && size && (exportSize.width !== size.width || exportSize.height !== size.height));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2 text-white" data-testid="image-markup-editor" aria-busy={saving} style={{ height: "min(72dvh, 740px)", maxHeight: "100%" }}>
      <div className="flex shrink-0 flex-wrap items-center gap-2" role="group" aria-label="Drawing tools">
        <Button autoFocus size="sm" aria-pressed={tool === "pen"} variant={tool === "pen" ? "primary" : "secondary"} isDisabled={busy} onPress={() => setTool("pen")}>Pen</Button>
        <Button size="sm" aria-pressed={tool === "arrow"} variant={tool === "arrow" ? "primary" : "secondary"} isDisabled={busy} onPress={() => setTool("arrow")}>Arrow</Button>
        <Button size="sm" isDisabled={busy || !strokeCount} onPress={() => { strokesRef.current.pop(); setStrokeCount(strokesRef.current.length); schedulePaint(); }}>Undo</Button>
        <Button size="sm" isDisabled={busy || !strokeCount} onPress={() => { strokesRef.current = []; setStrokeCount(0); schedulePaint(); }}>Clear drawing</Button>
      </div>
      <p id={descriptionId} className="shrink-0 text-xs text-slate-300">
        Use a finger, mouse or pen to draw. {optimized && outputSize ? `PNG export optimized to ${outputSize.width} × ${outputSize.height} pixels (${formatExportLimit(exportLimit)} limit).` : `PNG export, up to 2048 pixels and ${formatExportLimit(exportLimit)}.`}
        {strokeCount >= MAX_STROKES ? " Drawing limit reached; undo or clear to continue." : null}
      </p>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden" style={{ minHeight: 80 }}>
        <canvas
          ref={canvasRef}
          width={1}
          height={1}
          role="img"
          aria-label={`Draw on ${alt}`}
          aria-describedby={descriptionId}
          data-testid={canvasTestId}
          className="block max-h-full max-w-full touch-none rounded-lg"
          style={{ width: "auto", height: "auto", maxHeight: "100%", visibility: size ? "visible" : "hidden", cursor: saving ? "wait" : "crosshair" }}
          onPointerDown={(event) => {
            if (!size || savingRef.current || activeRef.current || event.button !== 0 || strokesRef.current.length >= MAX_STROKES) return;
            const point = pointFromEvent(event);
            if (!point) return;
            event.preventDefault();
            activeRef.current = { pointerId: event.pointerId, stroke: { tool, points: [point] } };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrawing(true);
            schedulePaint();
          }}
          onPointerMove={(event) => {
            if (savingRef.current || activeRef.current?.pointerId !== event.pointerId) return;
            const point = pointFromEvent(event);
            if (point) { addPoint(point); schedulePaint(); }
          }}
          onPointerUp={(event) => endStroke(event, false)}
          onPointerCancel={(event) => endStroke(event, true)}
          onLostPointerCapture={(event) => endStroke(event, true)}
        />
        {!size && !error ? <p role="status" className="text-sm text-slate-300">Loading image…</p> : null}
      </div>
      {error ? <p role="alert" className="shrink-0 text-sm text-red-300">{error}</p> : null}
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button size="sm" isDisabled={busy} onPress={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" isDisabled={busy || !size} onPress={() => { void handleSave(); }}>{saving ? "Saving…" : saveLabel}</Button>
      </div>
    </div>
  );
}
