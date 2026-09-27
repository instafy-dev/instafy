import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { Check, Link, MoreHoriz, Plus, Refresh, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { addFloatingSurfaceViewportChangeListener, readStudioSafeAreaInsets } from "../../../utils/floatingSurfacePosition";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import type { BrowserRuntimeCandidate } from "./browserSessionRuntimeEnsure";

export function SharedBrowserSessionControl({ runtimeId, resumeUrl, open, busy, candidates, error, canStart, selectionRequired = false,
  onOpenChange, onChoose, onStart, onRefresh, children, footer }: {
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
  footer?: ReactNode;
}) {
  const [copyStatus, setCopyStatus] = useState<{ url: string; text: string } | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
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
      className="w-80 max-w-[calc(100vw-1.5rem)] p-1.5"
      data-browser-session-safe-zone="true" data-testid="shared-browser-session-control">
      <Dialog aria-label="Browser options" className="outline-none">
        <section className="text-sm" aria-label="Shared sessions and resume">
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">Browser options</h3>
            <IconButton size="xs" variant="ghost" aria-label="Close browser options" onPress={() => onOpenChange(false)}>
              <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </div>
          {resumeUrl ? <Button size="sm" variant="ghost" className="w-full justify-start" onPress={() => {
            void writeClipboardText(resumeUrl).then(
              () => setCopyStatus({ url: resumeUrl, text: "Resume link copied." }),
              () => {
                setCopyStatus({ url: resumeUrl, text: "Could not copy. Select and copy the link in Session details." });
                if (detailsRef.current) {
                  detailsRef.current.open = true;
                  detailsRef.current.querySelector("input")?.focus();
                }
              },
            );
          }}><Link className="h-4 w-4 shrink-0" aria-hidden="true" />Copy resume link</Button> : null}
          {copyStatus?.url === resumeUrl ? <p className="px-2.5 py-1 text-xs" role="status">{copyStatus.text}</p> : null}
          {canStart ? <Button size="sm" variant="ghost" className="w-full justify-start" isDisabled={busy} onPress={onStart}>
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />Start new session
          </Button> : null}
          <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700/50">
            <div className="flex items-center justify-between px-2 py-1">
              <h4 className="text-xs text-slate-500 dark:text-slate-400">Sessions</h4>
              <IconButton size="xs" variant="ghost" isDisabled={busy} aria-label="Refresh sessions" title="Refresh sessions" onPress={onRefresh}>
                <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            </div>
            {error ? <p className="px-2.5 py-1 text-xs" role={selectionRequired ? "status" : "alert"}>{error}</p> : null}
            {candidates.map((candidate) => <Button key={candidate.runtimeId} size="sm" variant="ghost" isDisabled={busy}
              className="w-full justify-start text-left" onPress={() => onChoose(candidate.runtimeId)} aria-label={`Resume Shared session ${candidate.runtimeId}`}>
              <span className="min-w-0 flex-1 truncate">Session {candidate.runtimeId.slice(0, 8)}</span>
              {candidate.runtimeId === runtimeId ? <><span className="text-xs text-slate-500 dark:text-slate-400">Current</span><Check className="h-4 w-4 shrink-0" aria-hidden="true" /></> : null}
            </Button>)}
          </div>
          <details ref={detailsRef} className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700/50">
            <summary className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-100 pointer-coarse:min-h-11 pointer-coarse:py-3.5 dark:text-slate-400 dark:hover:bg-[var(--color-studio-dark-control-hover)]">Session details</summary>
            <div className="space-y-2 px-2.5 py-2 text-xs">
              <p>Members of this space can use the resume link to join and request control.</p>
              {runtimeId ? <p className="break-all" data-testid="shared-browser-current-runtime">Current session: {runtimeId}</p> : null}
              {resumeUrl ? <input aria-label="Shared Browser resume link" className="w-full min-w-0 rounded border border-slate-300 bg-transparent px-2 py-1 text-base pointer-coarse:min-h-11 dark:border-slate-700 sm:text-xs"
                readOnly value={resumeUrl} onFocus={(event) => event.currentTarget.select()} /> : null}
              {children}
            </div>
          </details>
          {footer}
        </section>
      </Dialog>
    </StudioPopover>
  </DialogTrigger>;
}
