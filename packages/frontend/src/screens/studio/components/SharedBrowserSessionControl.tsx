import { useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
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
  return <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
    data-browser-session-safe-zone="true" data-testid="shared-browser-session-control">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <span title={runtimeId ?? undefined}>Shared session {runtimeId ? runtimeId.slice(0, 8) : "not selected"}</span>
      <Button size="xs" variant="ghost" onPress={() => onOpenChange(!open)} aria-expanded={open}
        data-testid="shared-browser-sessions-toggle">Sessions &amp; resume</Button>
    </div>
    {open ? <section className="mt-2 max-h-[min(50dvh,24rem)] space-y-2 overflow-y-auto pb-2" aria-label="Shared sessions and resume">
      <p>Resume the same running browser on another device. Sign-in and access to this space are still required; control is requested separately.</p>
      {runtimeId ? <p className="break-all" data-testid="shared-browser-current-runtime">Current session: {runtimeId}</p> : null}
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
      {children}
    </section> : null}
  </div>;
}
