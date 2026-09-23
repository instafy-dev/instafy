import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChatLines, Clock, Page, Search, Settings, Xmark } from 'iconoir-react';
import { StudioSearchResultCopy, type StudioSearchMessageExcerpt } from './StudioSearchResultCopy';
import './StudioSearch.css';

export type StudioSearchScope = 'space' | 'org' | 'all';
export type StudioSearchResultGroup = 'Messages' | 'Chats' | 'Files' | 'Settings' | 'Actions';
export interface StudioSearchRecord {
  id: string;
  title: string;
  description: string;
  keywords: string;
  group: StudioSearchResultGroup;
  orgId: string;
  spaceId: string | null;
  message?: StudioSearchMessageExcerpt;
  activate: () => void;
}
export interface StudioSearchRequest {
  open: boolean;
  scope: StudioSearchScope;
  query: string;
  restoreMessagePages?: number;
}
export interface StudioSearchSnapshot {
  query: string;
  scope: StudioSearchScope;
  scrollTop: number;
  resultId: string;
  resultLimit: number;
  messagePageCount: number;
}
export interface StudioSearchProps {
  scopeKey: string;
  org: { id: string; name: string } | null;
  space: { id: string; name: string } | null;
  /** Only records accessible to the current account may be supplied. */
  records: readonly StudioSearchRecord[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Explains any limits of the available index, such as files in the current space only. */
  notice?: ReactNode;
  onOpen?: () => void;
  /** Starts or scopes authenticated data discovery in the same event as the UI change. */
  onRequestChange?: (request: StudioSearchRequest) => void;
  restoreSession?: (StudioSearchSnapshot & { restoreKey: string }) | null;
  onBeforeResultActivate?: (snapshot: StudioSearchSnapshot) => void;
  onDismiss?: () => void;
  hasMoreMessages?: boolean;
  loadingMoreMessages?: boolean;
  onLoadMoreMessages?: () => void;
  messagePageCount?: number;
  fullPage?: boolean;
  persistentControl?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}
interface SearchState {
  scopeKey: string;
  open: boolean;
  query: string;
  scope: StudioSearchScope;
}

const GROUPS: StudioSearchResultGroup[] = ['Messages', 'Chats', 'Files', 'Settings', 'Actions'];
const GROUP_ICONS = { Messages: ChatLines, Chats: ChatLines, Files: Page, Settings, Actions: Clock };

function canFocusSearchTarget(candidate: HTMLElement | null | undefined): candidate is HTMLElement {
  if (!candidate?.isConnected || !candidate.getClientRects().length || candidate.closest('[inert], [aria-hidden="true"], [hidden]')) return false;
  const style = getComputedStyle(candidate);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && candidate.getAttribute('aria-disabled') !== 'true' && !(candidate instanceof HTMLButtonElement && candidate.disabled);
}

/** A temporary search surface over records supplied by the authenticated Studio shell. */
export function useStudioSearch({ scopeKey, org, space, records, loading = false, error, onRetry, notice, onOpen, onRequestChange, restoreSession, onBeforeResultActivate, onDismiss, hasMoreMessages, loadingMoreMessages, onLoadMoreMessages, messagePageCount = 1, fullPage = true, persistentControl = false, returnFocusRef }: StudioSearchProps) {
  const defaultScope: StudioSearchScope = space ? 'space' : org ? 'org' : 'all';
  const [search, setSearch] = useState<SearchState>({ scopeKey, open: false, query: '', scope: defaultScope });
  // Hide stale results synchronously; effects alone could expose the old scope for one paint.
  const open = search.scopeKey === scopeKey && search.open;
  const query = search.scopeKey === scopeKey ? search.query : '';
  const resolveScope = (value: StudioSearchScope): StudioSearchScope => value === 'space' && !space ? org ? 'org' : 'all' : value === 'org' && !org ? 'all' : value;
  const scope = resolveScope(search.scopeKey === scopeKey ? search.scope : defaultScope);
  const scopeName = scope === 'space' ? space!.name : scope === 'org' ? org!.name : 'all orgs';
  const titleId = useId();
  const resultsId = useId();
  const scopeHintId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const resultsScrollRef = useRef<HTMLDivElement>(null);
  const appliedRestore = useRef<string | null>(null);
  const pendingRestoreScroll = useRef<StudioSearchSnapshot | null>(null);
  const restoreFocusRef = useRef(false);
  const suppressInputFocusOpenRef = useRef(false);
  const openRequestedRef = useRef(open);
  openRequestedRef.current = open;
  useEffect(() => {
    restoreFocusRef.current = false;
    setSearch(previous => previous.scopeKey === scopeKey ? previous : { scopeKey, open: false, query: '', scope: defaultScope });
  }, [scopeKey, defaultScope]);
  useEffect(() => {
    if (!open || !fullPage) return;
    // A closing navigation modal restores its old focus after initial autoFocus.
    // Run after that dismissal, while respecting a deliberate move within search.
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!canFocusSearchTarget(input)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && canFocusSearchTarget(active) && active.closest('.studio-search-control, .studio-search-panel')) return;
      input.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [fullPage, open, scopeKey]);
  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    const frame = requestAnimationFrame(() => {
      restoreFocusRef.current = false;
      // Full-page mobile search returns to a trigger outside this hook's control.
      // Only explicit dismissal reaches here; selecting a result suppresses it.
      const trigger = [persistentControl ? inputRef.current : null, triggerRef.current, returnFocusRef?.current].find(canFocusSearchTarget);
      suppressInputFocusOpenRef.current = true;
      try { trigger?.focus({ preventScroll: true }); }
      finally { suppressInputFocusOpenRef.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, persistentControl, returnFocusRef, scopeKey]);
  const openSearch = () => {
    const alreadyRequested = openRequestedRef.current;
    openRequestedRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
    restoreFocusRef.current = false;
    setSearch(previous => ({ scopeKey, open: true, query: previous.scopeKey === scopeKey ? previous.query : '', scope: previous.scopeKey === scopeKey ? resolveScope(previous.scope) : defaultScope }));
    onRequestChange?.({ open: true, scope, query });
    if (!persistentControl || !alreadyRequested) onOpen?.();
  };
  const closeSearch = (restoreFocus = true) => {
    pendingRestoreScroll.current = null;
    if (restoreFocus) onDismiss?.();
    openRequestedRef.current = false;
    restoreFocusRef.current = restoreFocus;
    setSearch(previous => ({ scopeKey, open: false, query: persistentControl ? '' : previous.scopeKey === scopeKey ? previous.query : '', scope: persistentControl ? defaultScope : scope }));
    onRequestChange?.({ open: false, scope: persistentControl ? defaultScope : scope, query: persistentControl ? '' : query });
  };
  const changeScope = (next: StudioSearchScope, focusInput = false) => {
    pendingRestoreScroll.current = null;
    const shouldOpen = persistentControl && !openRequestedRef.current;
    openRequestedRef.current = true;
    const nextScope = resolveScope(next);
    setSearch({ scopeKey, open: true, query, scope: nextScope });
    onRequestChange?.({ open: true, scope: nextScope, query });
    if (shouldOpen) onOpen?.();
    if (focusInput) inputRef.current?.focus();
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || persistentControl && !open) return;
    event.preventDefault();
    event.stopPropagation();
    closeSearch();
  };
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = records.filter(record => {
    if (scope === 'space' && (record.spaceId !== space!.id || org && record.orgId !== org.id)) return false;
    if (scope === 'org' && record.orgId !== org!.id) return false;
    // Message excerpts may omit other matching text; the server already matched
    // the complete message. Never carry a server hit over to a different query.
    if (record.message) return record.message.query === query.trim();
    const searchable = `${record.title} ${record.description} ${record.keywords}`.toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  // Keyboard traversal follows the same grouped order that is painted below.
  const matches = GROUPS.flatMap(group => filtered.filter(record => record.group === group));
  const resultPageKey = JSON.stringify([scopeKey, scope, query]);
  const [resultPage, setResultPage] = useState({ key: resultPageKey, limit: 100 });
  const resultLimit = resultPage.key === resultPageKey ? resultPage.limit : 100;
  const visibleMatches = matches.slice(0, resultLimit);
  useLayoutEffect(() => {
    if (!restoreSession || appliedRestore.current === restoreSession.restoreKey) return;
    appliedRestore.current = restoreSession.restoreKey;
    const restoredScope = restoreSession.scope === 'space' && !space ? org ? 'org' : 'all'
      : restoreSession.scope === 'org' && !org ? 'all' : restoreSession.scope;
    openRequestedRef.current = true;
    setSearch({ scopeKey, open: true, query: restoreSession.query, scope: restoredScope });
    setResultPage({ key: JSON.stringify([scopeKey, restoredScope, restoreSession.query]), limit: restoreSession.resultLimit });
    pendingRestoreScroll.current = restoreSession;
    onRequestChange?.({ open: true, scope: restoredScope, query: restoreSession.query, restoreMessagePages: restoreSession.messagePageCount });
  }, [onRequestChange, org, restoreSession, scopeKey, space]);
  useEffect(() => {
    if (!open || loading || loadingMoreMessages || !pendingRestoreScroll.current) return;
    const saved = pendingRestoreScroll.current;
    const frame = requestAnimationFrame(() => {
      if (pendingRestoreScroll.current !== saved) return;
      if (resultsScrollRef.current) resultsScrollRef.current.scrollTop = saved.scrollTop;
      resultRefs.current.get(saved.resultId)?.focus({ preventScroll: true });
      pendingRestoreScroll.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, loadingMoreMessages, open, visibleMatches.length]);
  const focusResult = (index: number) => {
    const target = visibleMatches[index] && resultRefs.current.get(visibleMatches[index].id);
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };
  const onResultKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      focusResult((index + 1) % visibleMatches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (index === 0) inputRef.current?.focus();
      else focusResult(index - 1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      focusResult(event.key === 'Home' ? 0 : visibleMatches.length - 1);
    }
  };
  const renderControl = (iconOnly = false, tokensOverride?: ReactNode): ReactNode => open || persistentControl ? (
    <div className="studio-search-control" data-search-persistent={persistentControl || undefined} data-search-open={open} onKeyDown={onSearchKeyDown}>
      <div className="studio-search-field" onClick={event => {
        if (event.target instanceof Element && !event.target.closest('button, input, select, a')) {
          if (persistentControl && !openRequestedRef.current) openSearch();
          inputRef.current?.focus({ preventScroll: true });
        }
      }}>
        <Search className="studio-search-leading-icon" aria-hidden="true" />
        <div className="studio-search-tokens" aria-label="Search scope">
          {tokensOverride === undefined ? <>{scope !== 'all' && org ? <span className="studio-search-chip" title={org.name}>
            <span>{org.name}</span><button type="button" aria-label="Search all orgs" title="Search all orgs" onClick={() => changeScope('all', true)}><Xmark aria-hidden="true" /></button>
          </span> : null}
          {scope === 'space' && space ? <>
            {org ? <span className="studio-search-separator" aria-hidden="true">/</span> : null}
            <span className="studio-search-chip" title={space.name}>
              <span>{space.name}</span><button type="button" aria-label={org ? `Search within ${org.name}` : 'Search all orgs'} title={org ? `Search within ${org.name}` : 'Search all orgs'} onClick={() => changeScope(org ? 'org' : 'all', true)}><Xmark aria-hidden="true" /></button>
            </span>
          </> : null}
          {scope === 'all' ? <span className="studio-search-all">All orgs</span> : null}</> : tokensOverride}
        </div>
        <div className="studio-search-entry">
          <input ref={inputRef} type="search" autoFocus={!persistentControl} value={query} maxLength={200}
            aria-label={`Search chats, files, settings in ${scopeName}`} aria-controls={open ? resultsId : undefined} aria-describedby={open ? scopeHintId : undefined}
            placeholder="Search…" data-testid="studio-search-input"
            onFocus={() => {
              if (persistentControl && !suppressInputFocusOpenRef.current && !openRequestedRef.current) openSearch();
            }}
            onClick={() => {
              if (persistentControl && !openRequestedRef.current) openSearch();
            }}
            onChange={event => {
              pendingRestoreScroll.current = null;
              const shouldOpen = persistentControl && !openRequestedRef.current;
              openRequestedRef.current = true;
              setSearch({ scopeKey, open: true, query: event.target.value, scope });
              onRequestChange?.({ open: true, scope, query: event.target.value });
              if (shouldOpen) onOpen?.();
            }}
            onKeyDown={event => {
              if (event.key === 'Backspace' && query.length === 0 && !event.repeat && !event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && scope !== 'all') {
                event.preventDefault();
                event.stopPropagation();
                changeScope(scope === 'space' && org ? 'org' : 'all');
              } else if (open && matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                event.stopPropagation();
                focusResult(event.key === 'ArrowDown' ? 0 : visibleMatches.length - 1);
              }
            }} />
        </div>
      </div>
      <button type="button" className="studio-search-close" aria-label="Close search" title="Close search" data-search-closed={!open || undefined}
        inert={!open || undefined} aria-hidden={!open || undefined} disabled={!open} tabIndex={!open ? -1 : undefined} onClick={() => closeSearch()}>
        <Xmark aria-hidden="true" /><span className="studio-search-done" aria-hidden="true">Done</span>
      </button>
    </div>
  ) : (
    <button ref={triggerRef} type="button"
      className={`studio-search-trigger${iconOnly ? ' studio-search-trigger-icon' : ''}`}
      aria-label={`Search ${scopeName}`} title={`Search ${scopeName}`} aria-expanded={false}
      data-testid="studio-search-trigger"
      onClick={event => { event.currentTarget.focus(); openSearch(); }}>
      <Search aria-hidden="true" />{!iconOnly ? <span>Search…</span> : null}
    </button>
  );
  const results: ReactNode = open ? (
    <section className={`studio-search-panel${fullPage ? ' studio-search-page' : ''}`} aria-labelledby={titleId} onKeyDown={onSearchKeyDown}>
      <div className="studio-search-scope-header">
        <div className="studio-search-heading">
          <h2 id={titleId} className="studio-search-scope">{fullPage ? 'Search results' : scope === 'all' ? 'Search across all orgs' : `Search in ${scopeName}`}</h2>
          {fullPage ? <span className="studio-search-count">{matches.length} {matches.length === 1 ? 'result' : 'results'}</span> : null}
        </div>
        <label className="studio-search-scope-select"><span>Scope</span><select aria-label="Search scope" value={scope} onChange={event => changeScope(event.target.value as StudioSearchScope)}>
          {space ? <option value="space">Current space</option> : null}
          {org ? <option value="org">Current org</option> : null}
          <option value="all">All orgs</option>
        </select></label>
      </div>
      <p id={scopeHintId} className="studio-search-hint">Backspace with an empty query broadens scope.</p>
      <div ref={resultsScrollRef} id={resultsId} className="studio-search-results" data-testid="studio-search-results" aria-busy={loading || Boolean(loadingMoreMessages)}>
        {loading ? <p className="studio-search-status" role="status">Searching…</p> : null}
        {error ? <div className="studio-search-status studio-search-error" role="alert">
          <p>{error}</p>
          {onRetry ? <button type="button" onClick={onRetry}>Retry search</button> : null}
        </div> : null}
        <span className="studio-search-sr-only" role={loading ? undefined : "status"}>{matches.length} {matches.length === 1 ? 'result' : 'results'}</span>
        {GROUPS.map(group => {
          const groupResults = visibleMatches.filter(result => result.group === group);
          if (!groupResults.length) return null;
          const Icon = GROUP_ICONS[group];
          const headingId = `${resultsId}-${group.toLowerCase()}`;
          return <section key={group} aria-labelledby={headingId}>
            <h3 id={headingId}>{group}{' '}
              {group === 'Messages' ? <span className="studio-search-order">Newest first</span>
                : group === 'Chats' ? <span className="studio-search-order">Recent activity</span> : null}
            </h3>
            {groupResults.map(result => <button type="button" key={result.id}
              ref={element => {
                if (element) resultRefs.current.set(result.id, element);
                else resultRefs.current.delete(result.id);
              }}
              className="studio-search-result" data-testid={`studio-search-result-${result.id}`}
              onKeyDown={event => onResultKeyDown(event, visibleMatches.indexOf(result))}
              onClick={() => {
                onBeforeResultActivate?.({ query, scope, scrollTop: resultsScrollRef.current?.scrollTop ?? 0,
                  resultId: result.id, resultLimit, messagePageCount });
                closeSearch(false);
                result.activate();
              }}>
              <Icon aria-hidden="true" />
              <StudioSearchResultCopy title={result.title} description={result.description} message={result.message} />
            </button>)}
          </section>;
        })}
        {visibleMatches.length < matches.length ? <button type="button" className="studio-search-more" onClick={() => setResultPage({ key: resultPageKey, limit: resultLimit + 100 })}>
          Show {Math.min(100, matches.length - visibleMatches.length)} more results ({visibleMatches.length} of {matches.length} shown)
        </button> : null}
        {hasMoreMessages ? <button type="button" className="studio-search-more" disabled={loadingMoreMessages} onClick={onLoadMoreMessages}>
          {loadingMoreMessages ? 'Loading more messages…' : 'Load more message results'}
        </button> : null}
        {!matches.length && !loading && !error ? <p className="studio-search-empty">No results in this scope. Try another query or a wider scope.</p> : null}
      </div>
      <footer className="studio-search-footer">{notice ? <span>{notice}</span> : null}<span>↑ ↓ to move · Enter to open</span></footer>
    </section>
  ) : null;
  return { open, openSearch, closeSearch, changeScope, renderControl, results, scope, query };
}
