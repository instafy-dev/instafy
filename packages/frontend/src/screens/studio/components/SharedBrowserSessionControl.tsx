import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { MoreHoriz, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { addFloatingSurfaceViewportChangeListener, readStudioSafeAreaInsets } from "../../../utils/floatingSurfacePosition";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import type { BrowserRuntimeCandidate } from "./browserSessionRuntimeEnsure";

export function SharedBrowserSessionControl({ runtimeId, resumeUrl, open, busy, candidates, error, canStart, selectionRequired = false,
  onOpenChange, onChoose, onStart, onRefresh, children }: {
  runtimeId: string | null;
  resumeUrl: string | null;
  open: boolean;
  busy: boolean;
  candidates: BrowserRuntimeCandidate[];
  error: string | null;
  selectionRequired?: boolean;
  canStart: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (runtimeId: string) => void;
  onStart: () => void;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const [copyStatus, setCopyStatus] = useState<{ url: string; text: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [bounds, setBounds] = useState({ containerPadding: 12, maxHeight: 512 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const insets = readStudioSafeAreaInsets();
      const viewport = window.visualViewport;
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const triggerBottom = triggerRef.current?.getBoundingClientRect().bottom ?? 0;
      // React Aria's collision padding is symmetric. Use horizontal insets for
      // it and bound the height separately so a top notch cannot narrow the menu.
      const next = {
        containerPadding: Math.max(12, insets.left, insets.right),
        maxHeight: Math.max(0, Math.min(512, viewportBottom - insets.bottom - triggerBottom - 18)),
      };
      setBounds(previous => previous.containerPadding === next.containerPadding && previous.maxHeight === next.maxHeight ? previous : next);
    };
    update();
    return addFloatingSurfaceViewportChangeListener(update);
  }, [open]);
  return <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
    <IconButton ref={triggerRef} size="sm" variant="ghost" radius="full" aria-label="Browser options" title="Browser options"
      className="shrink-0 max-[540px]:h-10 max-[540px]:w-10" data-browser-session-safe-zone="true"
      data-testid="shared-browser-sessions-toggle">
      <MoreHoriz className="h-4 w-4" aria-hidden="true" />
    </IconButton>
    <StudioPopover placement="bottom end" offset={6} maxHeight={bounds.maxHeight} containerPadding={bounds.containerPadding}
      className="w-96 max-w-[calc(100vw-1.5rem)] p-3"
      data-browser-session-safe-zone="true" data-testid="shared-browser-session-control">
      <Dialog aria-label="Browser options" className="outline-none">
        <section className="space-y-3 text-xs" aria-label="Shared sessions and resume">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Browser sessions</h3>
            <IconButton size="sm" variant="ghost" aria-label="Close browser options" onPress={() => onOpenChange(false)}>
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
          <p>Continue this browser on another device. Members of this space can open the link and request control.</p>
          {resumeUrl ? <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onPress={() => {
              void writeClipboardText(resumeUrl).then(() => setCopyStatus({ url: resumeUrl, text: "Resume link copied." }),
                () => setCopyStatus({ url: resumeUrl, text: "Could not copy. Select and copy the link below." }));
            }}>Copy resume link</Button>
            <input aria-label="Shared Browser resume link" className="min-w-0 flex-1 rounded border border-slate-300 bg-transparent px-2 py-1 text-base pointer-coarse:min-h-11 dark:border-slate-700 sm:text-xs"
              readOnly value={resumeUrl} onFocus={(event) => event.currentTarget.select()} />
            {copyStatus?.url === resumeUrl ? <span role="status">{copyStatus.text}</span> : null}
          </div> : null}
          {error ? <p role={selectionRequired ? "status" : "alert"}>{error}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" isDisabled={busy} onPress={onRefresh}>Refresh sessions</Button>
            {canStart ? <Button size="sm" variant="secondary" isDisabled={busy} onPress={onStart}>Start new session</Button> : null}
          </div>
          {candidates.map((candidate) => <Button key={candidate.runtimeId} size="sm" variant="secondary" isDisabled={busy}
            className="max-w-full" onPress={() => onChoose(candidate.runtimeId)} aria-label={`Resume Shared session ${candidate.runtimeId}`}>
            Resume session {candidate.runtimeId.slice(0, 8)}{candidate.runtimeId === runtimeId ? " (current)" : ""}
          </Button>)}
          {runtimeId ? <details>
            <summary className="cursor-pointer py-2 text-slate-500 dark:text-slate-400 pointer-coarse:min-h-11">Session details</summary>
            <p className="break-all" data-testid="shared-browser-current-runtime">Current session: {runtimeId}</p>
          </details> : null}
          {children}
        </section>
      </Dialog>
    </StudioPopover>
  </DialogTrigger>;
}
