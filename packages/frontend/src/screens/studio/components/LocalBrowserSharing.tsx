import type { LocalExploreState } from "../../../services/runtimeController/localTabExplore";
import { LocalTabControlRequests } from "./LocalTabControlRequests";
import type { LocalTabControlState } from "../../../services/runtimeController/localTabControl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SharedLocalTabViewer } from "./SharedLocalTabViewer";
import { Checkbox } from "../../../components/Checkbox";
import { Select } from "../../../components/Select";
import { Button } from "../../../components/Button";
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
  return <section aria-label="Choose tab audience" className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
    <Select aria-label="Share tab with" value={audience} onChange={event => setAudience(event.target.value as "selected" | "space")}>
      <option value="selected">Selected people</option><option value="space">Everyone with space access</option>
    </Select>
    {audience === "selected" ? <>
      <input aria-label="Find people with space access" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} placeholder="Find people…" className="w-full rounded border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700" />
      {selected.length ? <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">{selected.map(person => <Button key={person.userId} size="sm" variant="ghost" aria-label={`Deselect ${personLabel(person)}`} onPress={() => toggle(person, false)}>{personLabel(person)} ×</Button>)}</div> : null}
      <div className="max-h-40 space-y-2 overflow-y-auto">
        {loading ? <p role="status" className="text-xs">Loading people…</p> : people.map(person => <Checkbox key={person.userId} label={personLabel(person)} description={person.fullName ? person.email : undefined} isSelected={selected.some(p => p.userId === person.userId)} isDisabled={selected.length >= 32 && !selected.some(p => p.userId === person.userId)} onChange={checked => toggle(person, checked)} />)}
        {!loading && !people.length && !error ? <p className="text-xs">No people found with space access.</p> : null}
      </div>
      {hasMore ? <p className="text-xs">Search by name or email to find more people.</p> : null}
      {error ? <p role="alert" className="text-xs text-rose-600">{error}</p> : null}
    </> : null}
    <p className="text-xs text-slate-500">People start as viewers. You choose whether to allow control. Shared pages can include signed-in accounts.</p>
    <div className="flex gap-2"><Button size="sm" data-testid="local-browser-share-confirm" isDisabled={audience === "selected" && !selected.length} onPress={() => onShare(audience === "space" ? { audience } : { audience, viewerUserIds: selected.map(p => p.userId) })}>Start sharing</Button><Button size="sm" variant="ghost" onPress={onCancel}>Cancel</Button></div>
  </section>;
}

function ShareViewers({ projectId, share }: { projectId: string; share: BrowserShare }) {
  const [viewers, setViewers] = useState<BrowserShareViewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const removed = useRef(new Set<string>());
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
  }, [projectId, share.id]);
  async function remove(userId: string) {
    setBusy(userId); setError(null);
    try {
      await (await browserShareClient(projectId)).removeViewer(share.id, userId);
      removed.current.add(userId);
      setViewers(current => current.map(viewer => viewer.userId === userId ? { ...viewer, removed: true, active: false } : viewer));
    } catch { setError("Could not remove this person. Try again or stop sharing."); }
    finally { setBusy(null); }
  }
  return <section aria-label="Tab audience" className="space-y-1 text-xs" data-testid="local-browser-share-audience">
    {!viewers.length ? <p>{share.audience === "space" ? "No other viewers connected." : "Loading audience…"}</p> : null}
    <div className="max-h-40 space-y-1 overflow-y-auto">{viewers.map(viewer => <div key={viewer.userId} className="flex items-center justify-between gap-2" data-testid="local-browser-share-person">
      <span className="min-w-0 break-words">{personLabel(viewer)} · {viewer.removed ? "Removed from this share" : viewer.active ? "Viewing" : "Can view"}{viewer.fullName && viewer.email ? <span className="block text-slate-500">{viewer.email}</span> : null}</span>
      {!viewer.removed ? <Button size="sm" variant="ghost" isDisabled={busy !== null} aria-label={`Remove ${personLabel(viewer)}`} onPress={() => void remove(viewer.userId)}>Remove</Button> : null}
    </div>)}</div>
    <p className="text-slate-500">Removed people cannot rejoin this share. Their space membership stays unchanged.</p>
    {error ? <p role="alert" className="text-rose-600">{error}</p> : null}
  </section>;
}

export function LocalBrowserTabPublisher({ projectId, userId, ownerId, canShare }: { projectId: string; userId: string; ownerId: string | null; canShare: boolean }) {
  const [sharing, setSharing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const peopleId = useId();
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
    setError(null); setSharing(true); setChoosing(false); setShowPeople(false); setActiveShare(null); setControlState(null); setExploreState(null);
    const abort = new AbortController(); publisher.current = abort;
    void publishLocalBrowserTab(projectId, ownerId, abort.signal, message => {
      if (publisher.current !== abort) return;
      publisher.current = null; setSharing(false); setActiveShare(null); setError(message ?? null);
    }, audience, state => { if (publisher.current===abort) setControlState(state); }, state => { if (publisher.current===abort) setExploreState(state); }).then(share => { if (publisher.current === abort) setActiveShare(share ?? null); }).catch(e => { if (publisher.current === abort) { publisher.current = null; setSharing(false); setError(e instanceof Error ? e.message : "Could not share this tab."); } });
  }
  if (!canShare && !sharing && !error) return null;
  return <div className="shrink-0 space-y-2 border-b border-slate-200 bg-slate-50/60 px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900/40" data-testid="local-browser-sharing" aria-label="This tab's audience" data-browser-session-safe-zone="true">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {sharing ? <><span role="status">{activeShare ? activeShare.audience === "space" ? `Sharing · Everyone in this space · ${controlState?.grant ? "Control shared" : "View only"}` : `Sharing · Selected people · ${controlState?.grant ? "Control shared" : "View only"}` : "Starting tab sharing…"}</span>{activeShare ? <Button size="sm" variant="ghost" aria-expanded={showPeople} aria-controls={peopleId} data-testid="local-browser-share-people" onPress={() => setShowPeople(current => !current)}>People</Button> : null}<Button data-testid="local-browser-share-stop" size="sm" onPress={() => publisher.current?.abort()}>Stop sharing</Button></> : canShare ?
        <><span className="text-slate-500">Only you can see this tab</span><Button data-testid="local-browser-share-start" size="sm" variant="ghost" onPress={() => setChoosing(true)}>Share tab…</Button></> : null}
    </div>
    {choosing && canShare && !sharing ? <ShareAudiencePicker projectId={projectId} onShare={start} onCancel={() => setChoosing(false)} /> : null}
    {sharing && activeShare?.control ? <LocalTabControlRequests projectId={projectId} shareId={activeShare.id} state={controlState} control={activeShare.control} explore={activeShare.explore} exploreState={exploreState} /> : null}
    {sharing && activeShare ? <div id={peopleId} hidden={!showPeople}><ShareViewers key={activeShare.id} projectId={projectId} share={activeShare} /></div> : null}
    {error ? <p role="alert" className="text-xs text-rose-600">{error}</p> : null}
  </div>;
}

/** Incoming shares belong to the conversation, not the device/browser selector. */
export function LocalBrowserSharing({ projectId, userId }: { projectId: string; userId: string }) {
  const [shares, setShares] = useState<BrowserShare[]>([]);
  const [watching, setWatching] = useState<BrowserShare | null>(null);
  const retired = useRef(new Set<string>());
  const retire = useCallback((id: string) => {
    retired.current.add(id);
    setShares(current => current.filter(share => share.id !== id));
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: number;
    async function refresh() {
      try {
        const entries = await (await browserShareClient(projectId)).list();
        if (!disposed) setShares(entries.filter(share => !retired.current.has(share.id)));
      } catch { if (!disposed) setShares([]); }
      if (!disposed) timer = window.setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [projectId, userId]);
  if (!shares.length && !watching) return null;
  return <section aria-label="Tabs shared with you" className="shrink-0 space-y-2 px-3 py-2 sm:px-4" data-testid="local-browser-shared-tabs">
    {!watching ? <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-500">Tabs shared with you</span>
      {shares.map(share => <Button key={share.id} size="sm" variant="secondary" data-testid="local-browser-share-join" onPress={() => setWatching(share)}>View shared tab</Button>)}
    </div> : null}
    {watching ? <SharedLocalTabViewer key={watching.id} projectId={projectId} share={watching} onClose={() => setWatching(null)} onEnded={retire} /> : null}
  </section>;
}
