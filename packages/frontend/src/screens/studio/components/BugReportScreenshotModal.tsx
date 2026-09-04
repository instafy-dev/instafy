import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";

type StrokePoint = {
  x: number;
  y: number;
};

type Stroke = {
  points: StrokePoint[];
};

interface BugReportScreenshotModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  src: string | null;
  alt: string;
  editable?: boolean;
  onSave?: (nextDataUrl: string) => void | Promise<void>;
}

const MARKER_COLOR = "#ef4444";
const MARKER_WIDTH = 10;

async function loadImage(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load screenshot."));
    image.src = src;
  });
}

export function BugReportScreenshotModal({
  isOpen,
  onOpenChange,
  src,
  alt,
  editable = false,
  onSave,
}: BugReportScreenshotModalProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setStrokes([]);
  }, [isOpen, src]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || !isOpen) {
      return;
    }

    const updateSize = () => {
      const rect = image.getBoundingClientRect();
      setDisplaySize({ width: rect.width, height: rect.height });
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(image);
    return () => observer.disconnect();
  }, [isOpen, src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !editable || !naturalSize) {
      return;
    }
    canvas.width = naturalSize.width;
    canvas.height = naturalSize.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = MARKER_COLOR;
    context.lineWidth = MARKER_WIDTH;
    strokes.forEach((stroke) => {
      if (stroke.points.length === 0) {
        return;
      }
      context.beginPath();
      context.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let index = 1; index < stroke.points.length; index += 1) {
        const point = stroke.points[index];
        context.lineTo(point.x, point.y);
      }
      if (stroke.points.length === 1) {
        context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01);
      }
      context.stroke();
    });
  }, [editable, naturalSize, strokes]);

  const canAnnotate = editable && Boolean(src) && Boolean(onSave);

  const pointerToCanvasPoint = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): StrokePoint | null => {
      const canvas = canvasRef.current;
      if (!canvas || !naturalSize) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      const scaleX = naturalSize.width / rect.width;
      const scaleY = naturalSize.height / rect.height;
      return {
        x: Math.max(0, Math.min(naturalSize.width, (event.clientX - rect.left) * scaleX)),
        y: Math.max(0, Math.min(naturalSize.height, (event.clientY - rect.top) * scaleY)),
      };
    },
    [naturalSize],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!canAnnotate) {
        return;
      }
      const point = pointerToCanvasPoint(event);
      if (!point) {
        return;
      }
      activePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      setStrokes((current) => [...current, { points: [point] }]);
    },
    [canAnnotate, pointerToCanvasPoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!canAnnotate || activePointerIdRef.current !== event.pointerId) {
        return;
      }
      const point = pointerToCanvasPoint(event);
      if (!point) {
        return;
      }
      setStrokes((current) => {
        if (current.length === 0) {
          return current;
        }
        const next = [...current];
        const lastStroke = next[next.length - 1];
        next[next.length - 1] = {
          points: [...lastStroke.points, point],
        };
        return next;
      });
    },
    [canAnnotate, pointerToCanvasPoint],
  );

  const stopDrawing = useCallback((pointerId: number) => {
    if (activePointerIdRef.current === pointerId) {
      activePointerIdRef.current = null;
    }
  }, []);

  const handleClear = useCallback(() => {
    setStrokes([]);
  }, []);

  const handleSave = useCallback(async () => {
    if (!src || !onSave || !canAnnotate) {
      return;
    }
    setSaving(true);
    try {
      const baseImage = await loadImage(src);
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = baseImage.naturalWidth || naturalSize?.width || baseImage.width;
      outputCanvas.height = baseImage.naturalHeight || naturalSize?.height || baseImage.height;
      const context = outputCanvas.getContext("2d");
      if (!context) {
        throw new Error("Unable to prepare screenshot canvas.");
      }
      context.drawImage(baseImage, 0, 0, outputCanvas.width, outputCanvas.height);
      if (strokes.length > 0) {
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = MARKER_COLOR;
        context.lineWidth = MARKER_WIDTH;
        strokes.forEach((stroke) => {
          if (stroke.points.length === 0) {
            return;
          }
          context.beginPath();
          context.moveTo(stroke.points[0].x, stroke.points[0].y);
          for (let index = 1; index < stroke.points.length; index += 1) {
            const point = stroke.points[index];
            context.lineTo(point.x, point.y);
          }
          if (stroke.points.length === 1) {
            context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01);
          }
          context.stroke();
        });
      }
      await onSave(outputCanvas.toDataURL("image/png"));
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [canAnnotate, naturalSize?.height, naturalSize?.width, onOpenChange, onSave, src, strokes]);

  const hasAnnotations = strokes.length > 0;
  const helperText = useMemo(() => {
    if (!canAnnotate) {
      return null;
    }
    return hasAnnotations ? "Drag to mark the screenshot. Save to attach the markup." : "Draw directly on the screenshot with the red marker.";
  }, [canAnnotate, hasAnnotations]);

  // Backdrop-dismissable dialogs answer Escape too.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onOpenChange]);

  if (!isOpen || !src) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/75 backdrop-blur-sm pb-[max(var(--instafy-safe-area-inset-bottom),1rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),1rem)]"
      onClick={() => onOpenChange(false)}
      role="dialog"
      aria-modal="true"
      aria-label={editable ? "Annotate screenshot" : "Screenshot preview"}
      data-testid={editable ? "bug-report-screenshot-annotator" : "bug-report-screenshot-lightbox"}
      data-bug-report-overlay="true"
    >
      <div
        className="relative flex max-h-[min(92vh,100%)] w-full max-w-5xl flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-3 text-white sm:px-5">
          <div className="min-w-0">
            <Text variant="bodyStrong" tone="primary" className="truncate text-white">
              {alt}
            </Text>
            {helperText ? (
              <Text variant="caption" className="mt-1 block text-slate-300">
                {helperText}
              </Text>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {canAnnotate ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  radius="full"
                  onPress={handleClear}
                  isDisabled={!hasAnnotations || saving}
                  className="border-white/20 bg-transparent text-white hover:border-white/30 hover:bg-white/10"
                >
                  Clear drawing
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  radius="full"
                  onPress={() => {
                    void handleSave();
                  }}
                  isDisabled={saving}
                >
                  {saving ? "Saving…" : "Save markup"}
                </Button>
              </>
            ) : null}
            <IconButton
              type="button"
              variant="secondary"
              size="sm"
              radius="full"
              onPress={() => onOpenChange(false)}
              aria-label="Close screenshot preview"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-950 px-4 py-4 sm:px-6">
          <div
            className="relative inline-flex max-h-full max-w-full items-center justify-center"
            style={displaySize.width > 0 ? { width: displaySize.width } : undefined}
          >
            <img
              ref={imageRef}
              src={src}
              alt={alt}
              className="block max-h-[76vh] max-w-full rounded-2xl border border-white/10 object-contain shadow-lg"
              onLoad={(event) => {
                const image = event.currentTarget;
                setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
                const rect = image.getBoundingClientRect();
                setDisplaySize({ width: rect.width, height: rect.height });
              }}
            />
            {canAnnotate && displaySize.width > 0 && displaySize.height > 0 ? (
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full touch-none rounded-2xl"
                style={{ width: displaySize.width, height: displaySize.height }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => stopDrawing(event.pointerId)}
                onPointerCancel={(event) => stopDrawing(event.pointerId)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
