import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { ImageMarkupEditor } from "./ImageMarkupEditor";
import { BUG_REPORT_MAX_SCREENSHOT_BYTES } from "./bugReportDrafts";

interface BugReportScreenshotModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  src: string | null;
  alt: string;
  editable?: boolean;
  onSave?: (nextDataUrl: string) => void | Promise<void>;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unable to read screenshot markup."));
    reader.onerror = () => reject(new Error("Unable to read screenshot markup."));
    reader.readAsDataURL(blob);
  });
}

export function BugReportScreenshotModal({
  isOpen, onOpenChange, src, alt, editable = false, onSave,
}: BugReportScreenshotModalProps) {
  const [saving, setSaving] = useState(false);
  const canAnnotate = editable && Boolean(onSave);
  const saveScopeRef = useRef({ active: false, src });
  const openSessionRef = useRef({ active: false });

  useLayoutEffect(() => {
    const session = { active: isOpen };
    openSessionRef.current = session;
    return () => { session.active = false; };
  }, [isOpen]);

  useLayoutEffect(() => {
    const scope = { active: isOpen && Boolean(src), src };
    saveScopeRef.current = scope;
    return () => { scope.active = false; };
  }, [isOpen, src]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onOpenChange, saving]);

  if (!isOpen || !src) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/75 backdrop-blur-sm pb-[max(var(--instafy-safe-area-inset-bottom),1rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),1rem)]"
      onClick={() => { if (!saving) onOpenChange(false); }}
      role="dialog"
      aria-modal="true"
      aria-label={editable ? "Annotate screenshot" : "Screenshot preview"}
      data-testid={editable ? "bug-report-screenshot-annotator" : "bug-report-screenshot-lightbox"}
      data-bug-report-overlay="true"
    >
      <div
        className="relative flex max-h-[min(92dvh,100%)] w-full max-w-5xl flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 py-3 text-white sm:px-5">
          <Text variant="bodyStrong" tone="primary" className="min-w-0 truncate text-white">{alt}</Text>
          <IconButton type="button" variant="secondary" size="sm" radius="full" isDisabled={saving} onPress={() => onOpenChange(false)} aria-label="Close screenshot preview">
            <Xmark className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-950 px-4 py-3 sm:px-6">
          {canAnnotate ? (
            <ImageMarkupEditor
              src={src}
              alt={alt}
              canvasTestId="bug-report-screenshot-canvas"
              maxExportBytes={BUG_REPORT_MAX_SCREENSHOT_BYTES}
              onSavingChange={setSaving}
              onCancel={() => onOpenChange(false)}
              onSave={async (blob) => {
                const scope = saveScopeRef.current;
                const session = openSessionRef.current;
                const dataUrl = await blobToDataUrl(blob);
                if (!scope.active || saveScopeRef.current !== scope) return;
                await onSave!(dataUrl);
                // The parent may commit our saved preview before its promise
                // resolves. Close that edit, while leaving a new image/session alone.
                const current = saveScopeRef.current;
                if (session.active && openSessionRef.current === session && current.active &&
                  (current === scope || current.src === dataUrl)) onOpenChange(false);
              }}
            />
          ) : (
            <img src={src} alt={alt} className="block max-h-[76dvh] max-w-full rounded-2xl border border-white/10 object-contain shadow-lg" />
          )}
        </div>
      </div>
    </div>
  );
}
