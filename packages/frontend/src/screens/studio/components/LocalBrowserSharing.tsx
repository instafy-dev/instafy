import { Lock, WarningTriangle } from "iconoir-react";
import type { LocalExploreState } from "../../../services/runtimeController/localTabExplore";
import { LocalTabControlRequests } from "./LocalTabControlRequests";
import type { LocalTabControlState } from "../../../services/runtimeController/localTabControl";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrowserToolsOverlayContext, BrowserToolsPopover } from "./BrowserToolsPopover";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { SharedLocalTabViewer } from "./SharedLocalTabViewer";
import { Checkbox } from "../../../components/Checkbox";
import { Select } from "../../../components/Select";
import { Input } from "../../../components/Input";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Text } from "../../../components/Text";
import { StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { useGatedInterval } from "../../../runtime/pollingGate";
import { browserShareClient, publishLocalBrowserTab, type BrowserShare, type LocalTabPublication, type BrowserShareAudience, type BrowserSharePerson, type BrowserShareViewer } from "../../../services/runtimeController/browserShares";


function personLabel(person: BrowserSharePerson) {
  return person.fullName || person.email || `Member ${person.userId.slice(0, 8)}`;
}

function ShareAudiencePicker({ projectId, onShare, onCancel }: { projectId: string; onShare: (audience: BrowserShareAudience) => void; onCancel: () => void }) {
  const [audience, setAudience] = useState<"selected" | "space">("selected");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<BrowserSharePerson[]>([]);
  const [selected, setSelected] = useState<BrowserSharePerson[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(null);
    const timer = window.setTimeout(() => {
      void browserShareClient(projectId).then(client => client.people(query)).then(result => {
        if (!disposed) { setPeople(result.people); setHasMore(result.hasMore); setLoading(false); }
      }).catch(() => { if (!disposed) { setPeople([]); setLoading(false); setError("Could not load people. Try searching again."); } });
    }, 200);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [projectId, query]);
  function toggle(person: BrowserSharePerson, checked: boolean) {
    setSelected(current => checked ? [...current.filter(p => p.userId !== person.userId), person] : current.filter(p => p.userId !== person.userId));
  }
  return <section aria-label="Choose tab audience" className="space-y-3">
    <Select aria-label="Share tab with" value={audience} onChange={event => setAudience(event.target.value as "selected" | "space")}>
      <option value="selected">Selected people</option><option value="space">Everyone with space access</option>
    </Select>
    {audience === "selected" ? <>
      <Input size="sm" aria-label="Find people with space access" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} placeholder="Find people…" />
      {selected.length ? <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">{selected.map(person => <Button key={person.userId} preset="inline" variant="ghost" aria-label={`Deselect ${personLabel(person)}`} onPress={() => toggle(person, false)}>{personLabel(person)} ×</Button>)}</div> : null}
      <div className="max-h-40 space-y-2 overflow-y-auto">
        {loading ? <Text variant="caption" tone="muted" role="status">Loading people…</Text> : people.map(person => <Checkbox key={person.userId} label={personLabel(person)} description={person.fullName ? person.email : undefined} isSelected={selected.some(p => p.userId === person.userId)} isDisabled={selected.length >= 32 && !selected.some(p => p.userId === person.userId)} onChange={checked => toggle(person, checked)} />)}
        {!loading && !people.length && !error ? <Text variant="caption" tone="muted">No people found with space access.</Text> : null}
      </div>
      {hasMore ? <Text variant="caption" tone="muted">Search by name or email to find more people.</Text> : null}
      {error ? <Text role="alert" variant="caption" tone="danger">{error}</Text> : null}
    </> : null}
    <Text variant="caption" tone="muted">People start as viewers. You choose whether to allow control or independent browsing. Both can use this browser’s website logins and change shared data.</Text>
    <div className="flex flex-wrap gap-2"><Button preset="form" data-testid="local-browser-share-confirm" isDisabled={audience === "selected" && !selected.length} onPress={() => onShare(audience === "space" ? { audience } : { audience, viewerUserIds: selected.map(p => p.userId) })}>Start sharing</Button><Button preset="form" variant="ghost" onPress={onCancel}>Cancel</Button></div>
  </section>;
}

function ShareParticipants({ projectId, share, controlState, exploreState, onStop }: {
  onStop: () => void;
  projectId: string;
  share: LocalTabPublication;
  controlState: LocalTabControlState | null;
  exploreState: LocalExploreState | null;
}) {
  const [viewers, setViewers] = useState<BrowserShareViewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const removed = useRef(new Set<string>());
  // One audience snapshot supplies both the People panel and approval labels.
  const requestIds = [...(controlState?.requests ?? []), ...(exploreState?.requests ?? []), ...(exploreState?.views ?? [])]
    .map(request => request.connectionId).join(",");
  const controlUserId = controlState?.grant?.userId;
  useEffect(() => {
    let disposed = false; let timer: number;
    async function refresh() {
      try {
        const result = await (await browserShareClient(projectId)).viewers(share.id);
        if (!disposed) setViewers(result.map(viewer => removed.current.has(viewer.userId) ? { ...viewer, removed: true, active: false } : viewer).sort((a, b) => personLabel(a).localeCompare(personLabel(b)) || a.userId.localeCompare(b.userId)));
      } catch { if (!disposed) setError("Could not refresh the audience."); }
      if (!disposed) timer = window.setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [projectId, share.id, requestIds, controlUserId]);
  async function remove(userId: string) {
    setBusy(userId); setError(null);
    try {
      await (await browserShareClient(projectId)).removeViewer(share.id, userId);
      removed.current.add(userId);
      setViewers(current => current.map(viewer => viewer.userId === userId ? { ...viewer, removed: true, active: false } : viewer));
    } catch { setError("Could not remove this person. Try again or stop sharing."); }
    finally { setBusy(null); }
  }
  async function endBrowsing(userId: string) {
    setBusy(userId); setError(null);
    try {
      for (const view of exploreState?.views ?? []) {
        if (view.userId === userId) await share.explore?.close(view.viewId);
      }
    } catch { setError("Could not end browsing. Try again or stop sharing."); }
    finally { setBusy(null); }
  }
  // Keep active participants manageable even if the audience lookup is delayed.
  const participants = [...viewers];
  for (const participant of [...(exploreState?.views ?? []), ...(controlState?.grant ? [controlState.grant] : [])]) {
    if (!participants.some(viewer => viewer.userId === participant.userId)) {
      participants.push({ userId: participant.userId, fullName: null, email: null, active: true, removed: removed.current.has(participant.userId) });
    }
  }
  const requestCount = (controlState?.requests?.length ?? 0) + (exploreState?.requests?.length ?? 0);
  const controller = viewers.find(viewer => viewer.userId === controlUserId);
  return <BrowserToolsPopover label="Sharing settings" trigger={
    <Button preset="toolbar" variant="ghost" data-testid="local-browser-share-people" aria-label={requestCount ? `Sharing settings, ${requestCount} pending ${requestCount === 1 ? "request" : "requests"}` : "Sharing settings"}>
      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
      <span className="max-w-32 truncate">{controlUserId ? `${controller?.fullName || controller?.email || "Participant"} controls` : "Sharing"}</span>{requestCount ? <Badge tone="info" role="status">{requestCount}</Badge> : null}
    </Button>
  }>
    <Text variant="bodyStrong" tone="primary">{share.audience === "space" ? "Everyone in this space" : "Selected people"}</Text>
    {share.control ? <LocalTabControlRequests people={viewers} state={controlState} control={share.control} explore={share.explore} exploreState={exploreState} showTakeBack={false} /> : null}
      <section aria-label="Tab audience" className="space-y-2" data-testid="local-browser-share-audience">
      {!participants.length ? <Text variant="caption" tone="muted">{share.audience === "space" ? "No other viewers connected." : "Loading audience…"}</Text> : null}
      <div className="max-h-64 overflow-y-auto">{participants.map((viewer, index) => <div key={viewer.userId} data-testid="local-browser-share-person">
        {index ? <StudioMenuSeparator /> : null}
        <Text variant="bodyCompact" tone="primary" className="min-w-0 break-words">{personLabel(viewer)} · {viewer.removed ? "Removed from this share" : controlUserId === viewer.userId ? "Controlling your tab" : exploreState?.views?.some(view => view.userId === viewer.userId) ? "Browsing independently" : viewer.active ? "Following" : "Can view"}{viewer.fullName && viewer.email ? <Text as="span" variant="caption" tone="muted" className="block">{viewer.email}</Text> : null}</Text>
        {!viewer.removed ? <div className="mt-1 flex flex-wrap gap-2">
          {share.explore && exploreState?.views?.some(view => view.userId === viewer.userId) ? <Button preset="inline" variant="secondary" data-testid="local-tab-end-explore" aria-label={`End browsing for ${personLabel(viewer)}`} isDisabled={busy !== null} onPress={() => void endBrowsing(viewer.userId)}>End browsing</Button> : null}
          <Button preset="inline" variant="ghost" isDisabled={busy !== null} aria-label={`Remove ${personLabel(viewer)}`} onPress={() => void remove(viewer.userId)}>Remove</Button>
        </div> : null}
      </div>)}</div>
      <Text variant="caption" tone="muted">Removed people cannot rejoin this share. Their space membership stays unchanged.</Text>
      {error ? <Text role="alert" variant="caption" tone="danger">{error}</Text> : null}
      </section>
      <Button data-testid="local-browser-share-stop" title="Stop sharing this tab" preset="inline" variant="secondary" onPress={onStop}>Make private</Button>
  </BrowserToolsPopover>;
}

/** A native-page click asks first; the existing toolbar action stays immediate. */
function ParticipantTakeBack({ requestId, controlId, revoke }: { requestId?: string; controlId: string | null; revoke: () => Promise<void> }) {
  const [requestedControl, setRequestedControl] = useState<string | null>(null);
  const open = controlId !== null && requestedControl === controlId;
  const dismiss = () => setRequestedControl(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenRequest = useRef<string | undefined>(undefined);
  const registerOverlay = useContext(BrowserToolsOverlayContext);
  useEffect(() => {
    if (requestId && requestId !== seenRequest.current) { seenRequest.current = requestId; setError(null); setRequestedControl(controlId); }
  }, [requestId, controlId]);
  useLayoutEffect(() => open ? registerOverlay?.() : undefined, [open, registerOverlay]);
  async function takeBack() {
    setBusy(true); setError(null);
    try { await revoke(); dismiss(); }
    catch { setError("Could not take back control. Try again or stop sharing."); }
    finally { setBusy(false); }
  }
  return <StudioDialogModal isOpen={open} onOpenChange={next => { if (!next) dismiss(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy}
    dialogAriaLabel="Take back control" modalClassName="!max-w-sm" dialogClassName="p-5" data-browser-session-safe-zone="true">
    <h2 className="text-base font-semibold">Take back control?</h2>
    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Another participant is using your tab. They can keep watching when you take back control.</p>
    {error ? <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p> : null}
    <div className="mt-5 flex justify-end gap-2">
      <Button className="min-h-10 pointer-coarse:min-h-11" variant="ghost" isDisabled={busy} onPress={dismiss}>Keep watching</Button>
      <Button className="min-h-10 pointer-coarse:min-h-11" isDisabled={busy} onPress={() => void takeBack()}>{busy ? "Taking back…" : "Take back"}</Button>
    </div>
  </StudioDialogModal>;
}

export function LocalBrowserTabPublisher({ projectId, userId, ownerId, canShare, takeoverRequestId }: { projectId: string; userId: string; ownerId: string | null; canShare: boolean; takeoverRequestId?: string }) {
  const [sharing, setSharing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [activeShare, setActiveShare] = useState<LocalTabPublication | null>(null);
  const [exploreState, setExploreState] = useState<LocalExploreState | null>(null);
  const [controlState,setControlState]=useState<LocalTabControlState|null>(null);
  const [error, setError] = useState<string | null>(null);
  const publisher = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!canShare) { publisher.current?.abort(); publisher.current = null; setChoosing(false); }
    return () => { publisher.current?.abort(); publisher.current = null; };
  }, [canShare, ownerId, projectId, userId]);

  function start(audience: BrowserShareAudience) {
    if (!ownerId || publisher.current) return;
    setError(null); setSharing(true); setChoosing(false); setActiveShare(null); setControlState(null); setExploreState(null);
    const abort = new AbortController(); publisher.current = abort;
    void publishLocalBrowserTab(projectId, ownerId, abort.signal, message => {
      if (publisher.current !== abort) return;
      publisher.current = null; setSharing(false); setActiveShare(null); setError(message ?? null);
    }, audience, state => { if (publisher.current===abort) setControlState(state); }, state => { if (publisher.current===abort) setExploreState(state); }).then(share => { if (publisher.current === abort) setActiveShare(share ?? null); }).catch(e => { if (publisher.current === abort) { publisher.current = null; setSharing(false); setError(e instanceof Error ? e.message : "Could not share this tab."); } });
  }
  if (!canShare && !sharing && !error) return null;
  return <div className="flex shrink-0 items-center gap-2" data-testid="local-browser-sharing" aria-label="This tab's audience" data-browser-session-safe-zone="true">
    {sharing ? <>
      {activeShare ? <ShareParticipants key={activeShare.id} projectId={projectId} share={activeShare} controlState={controlState} exploreState={exploreState} onStop={() => publisher.current?.abort()} /> : <Text as="span" variant="caption" tone="muted" role="status">Sharing…</Text>}
      {activeShare?.control && controlState?.grant ? <Button preset="inline" data-testid="local-tab-take-back" aria-label="Take back control" onPress={() => void activeShare.control!.revoke().catch(() => setError("Could not take back control. Try again or stop sharing."))}>Take back</Button> : null}
      {activeShare?.control ? <ParticipantTakeBack key={activeShare.id} requestId={takeoverRequestId} controlId={canShare ? controlState?.grant?.id ?? null : null} revoke={activeShare.control.revoke} /> : null}
      {!activeShare ? <Button preset="inline" variant="ghost" onPress={() => publisher.current?.abort()}>Cancel</Button> : null}
    </> : canShare ? <BrowserToolsPopover label="Share this tab" isOpen={choosing} onOpenChange={setChoosing} trigger={
      <Button data-testid="local-browser-share-start" preset="toolbar" variant="ghost" aria-label="Private tab — change who can view" title="Only you can see this tab"><Lock className="h-3.5 w-3.5" aria-hidden="true" />Private</Button>
    }>
      <ShareAudiencePicker projectId={projectId} onShare={start} onCancel={() => setChoosing(false)} />
    </BrowserToolsPopover> : null}
    {error ? <BrowserToolsPopover label="Sharing problem" trigger={<IconButton variant="ghost" tone="danger" aria-label="Sharing problem"><WarningTriangle className="h-4 w-4" aria-hidden="true" /></IconButton>}><Text role="alert" variant="caption" tone="danger">{error}</Text></BrowserToolsPopover> : null}
  </div>;
}

export const INCOMING_SHARES_POLL_ACTIVE_MS = 5_000;
export const INCOMING_SHARES_POLL_IDLE_MS = 60_000;

/** Incoming shares belong to the conversation, not the device/browser selector. */
export function LocalBrowserSharing({ projectId, userId, active = true }: { projectId: string; userId: string; active?: boolean }) {
  const [shares, setShares] = useState<BrowserShare[]>([]);
  const [watching, setWatching] = useState<BrowserShare | null>(null);
  const retired = useRef(new Set<string>());
  const retire = useCallback((id: string) => {
    retired.current.add(id);
    setShares(current => current.filter(share => share.id !== id));
  }, []);
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    async function refresh() {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const entries = await (await browserShareClient(projectId)).list();
        if (!disposed) setShares(entries.filter(share => !retired.current.has(share.id)));
      } catch { if (!disposed) setShares([]); }
      finally { inFlight = false; }
    }
    refreshRef.current = () => void refresh();
    return () => { disposed = true; refreshRef.current = null; };
  }, [projectId, userId]);
  // Fetch once whenever the chat surface shows this list (and on project or
  // account change). This used to be a plain 5 s loop per mounted chat that
  // kept running in hidden chats, background tabs and idle windows, which made
  // it the single largest source of Studio requests.
  useEffect(() => {
    if (active) refreshRef.current?.();
  }, [active, projectId, userId]);
  // Every 5 s while someone is using the tab, every minute once idle, never
  // while hidden or while the chat surface is not shown; once on wake.
  useGatedInterval(() => refreshRef.current?.(), INCOMING_SHARES_POLL_ACTIVE_MS, { idleMs: INCOMING_SHARES_POLL_IDLE_MS, enabled: active });
  if (!shares.length && !watching) return null;
  return <section aria-label="Tabs shared with you" className="shrink-0 space-y-2 px-3 py-2 sm:px-4" data-testid="local-browser-shared-tabs">
    {!watching ? <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-500">Tabs shared with you</span>
      {shares.map(share => <Button key={share.id} size="sm" variant="secondary" data-testid="local-browser-share-join" onPress={() => setWatching(share)}>View shared tab</Button>)}
    </div> : null}
    {watching ? <SharedLocalTabViewer key={watching.id} projectId={projectId} share={watching} onClose={() => setWatching(null)} onEnded={retire} /> : null}
  </section>;
}
