import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { Check, Link, MoreHoriz, NavArrowDown, Plus, Refresh, Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { StudioMenuAction, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { STUDIO_MENU_NATIVE_ROW_CLASS } from "../../../components/aria/studioMenuStyles";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { addFloatingSurfaceViewportChangeListener, readStudioSafeAreaInsets } from "../../../utils/floatingSurfacePosition";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import type { BrowserRuntimeCandidate } from "./browserSessionRuntimeEnsure";

export function SharedBrowserSessionControl({ runtimeId, resumeUrl, open, busy, candidates, error, canStart, selectionRequired = false,
  onOpenChange, onChoose, onStart, onRefresh, actions, location, children, footer }: {
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
  actions?: ReactNode;
  /** Where the browser runs (`BrowserLocationOptions`): a setting, so it lives here, not in the toolbar. */
  location?: ReactNode;
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
    <IconButton ref={triggerRef} size="sm" variant="ghost" aria-label="Browser options" title="Browser options"
      className="shrink-0" data-browser-session-safe-zone="true"
      data-testid="shared-browser-sessions-toggle">
      <MoreHoriz className="h-4 w-4" aria-hidden="true" />
    </IconButton>
    <StudioPopover layout="menu" placement="bottom end" maxHeight={bounds.maxHeight} containerPadding={bounds.containerPadding}
      className="w-80"
      data-browser-session-safe-zone="true" data-testid="shared-browser-session-control">
      <Dialog aria-label="Browser options" className="outline-none">
        <section aria-label="Shared sessions and resume">
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <Text as="h3" variant="bodyStrong" tone="primary">Browser options</Text>
            <IconButton size="xs" variant="ghost" aria-label="Close browser options" onPress={() => onOpenChange(false)}>
              <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </div>
          {actions}
          {location ? <>
            {actions ? <StudioMenuSeparator /> : null}
            {location}
            {resumeUrl || canStart ? <StudioMenuSeparator /> : null}
          </> : null}
          {resumeUrl ? <StudioMenuAction onPress={() => {
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
          }}><MenuItemContent start={<Link aria-hidden="true" />}>Copy resume link</MenuItemContent></StudioMenuAction> : null}
          {copyStatus?.url === resumeUrl ? <Text variant="caption" tone="muted" className="px-2.5 py-1" role="status">{copyStatus.text}</Text> : null}
          {canStart ? <StudioMenuAction isDisabled={busy} onPress={onStart}>
            <MenuItemContent start={<Plus aria-hidden="true" />}>Start new session</MenuItemContent>
          </StudioMenuAction> : null}
          <StudioMenuSeparator />
          <div>
            <div className="flex items-center justify-between px-2 py-1">
              <Text as="h4" variant="caption" tone="muted">Sessions</Text>
              <IconButton size="xs" variant="ghost" isDisabled={busy} aria-label="Refresh sessions" title="Refresh sessions" onPress={onRefresh}>
                <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            </div>
            {error ? <Text variant="caption" tone={selectionRequired ? "muted" : "danger"} className="px-2.5 py-1" role={selectionRequired ? "status" : "alert"}>{error}</Text> : null}
            {candidates.map((candidate) => <StudioMenuAction key={candidate.runtimeId} isDisabled={busy}
              onPress={() => onChoose(candidate.runtimeId)} aria-label={`Resume Shared session ${candidate.runtimeId}`}>
              <MenuItemContent end={candidate.runtimeId === runtimeId ? <Check aria-hidden="true" /> : null}
                description={candidate.runtimeId === runtimeId ? "Current" : undefined}>
                {candidate.mode === "lazy" ? "This space's machine" : `Session ${candidate.runtimeId.slice(0, 8)}`}
              </MenuItemContent>
            </StudioMenuAction>)}
          </div>
          <StudioMenuSeparator />
          <details ref={detailsRef} className="group">
            <summary className={`${STUDIO_MENU_NATIVE_ROW_CLASS} list-none [&::-webkit-details-marker]:hidden`}>
              <MenuItemContent end={<NavArrowDown className="transition-transform group-open:rotate-180" aria-hidden="true" />}>Session details</MenuItemContent>
            </summary>
            <div className="space-y-2 px-2.5 py-2">
              <Text variant="caption" tone="muted">Members of this space can use the resume link to join and request control.</Text>
              {runtimeId ? <Text variant="caption" tone="muted" className="break-all" data-testid="shared-browser-current-runtime">Current session: {runtimeId}</Text> : null}
              {resumeUrl ? <Input size="xs" aria-label="Shared Browser resume link"
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
