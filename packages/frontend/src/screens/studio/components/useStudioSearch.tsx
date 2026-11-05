import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChatLines, Clock, Page, Search, Settings, Xmark } from 'iconoir-react';
import { Button, IconButton, type ButtonProps } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { CONTROL_RADIUS_CLASSES, CONTROL_TEXT_SIZE_CLASSES, CONTROL_TONE_CLASSES } from '../../../components/controlStyles';
import { textTones } from '../../../styles/typography';
import { StudioSearchScopeChip } from './StudioSearchScopeChip';
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
  restoreSpacePages?: number;
}
export interface StudioSearchSnapshot {
  query: string;
  scope: StudioSearchScope;
  scrollTop: number;
  resultId: string;
  resultLimit: number;
  messagePageCount: number;
  spacePageCount?: number;
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
  remainingSpaces?: number;
  onLoadMoreSpaces?: () => void;
  spacePageCount?: number;
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
export function useStudioSearch({ scopeKey, org, space, records, loading = false, error, onRetry, notice, onOpen, onRequestChange, restoreSession, onBeforeResultActivate, onDismiss, remainingSpaces = 0, onLoadMoreSpaces, spacePageCount = 1, hasMoreMessages, loadingMoreMessages, onLoadMoreMessages, messagePageCount = 1, fullPage = true, persistentControl = false, returnFocusRef }: StudioSearchProps) {
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
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape' || persistentControl && !open) return;
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
    onRequestChange?.({ open: true, scope: restoredScope, query: restoreSession.query, restoreMessagePages: restoreSession.messagePageCount, restoreSpacePages: restoreSession.spacePageCount });
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
  const onResultKeyDown = (event: Parameters<NonNullable<ButtonProps['onKeyDown']>>[0], index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusResult((index + 1) % visibleMatches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else focusResult(index - 1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusResult(event.key === 'Home' ? 0 : visibleMatches.length - 1);
    } else {
      // Shared buttons contain custom key handlers by default. Let Escape and
      // other unhandled keys reach the search surface and workspace shortcuts.
      event.continuePropagation();
    }
  };
  const renderControl = (iconOnly = false, tokensOverride?: ReactNode): ReactNode => open || persistentControl ? (
    <div className="studio-search-control" data-search-persistent={persistentControl || undefined} data-search-open={open} onKeyDown={onSearchKeyDown}>
      <div className={`studio-search-field border ${CONTROL_RADIUS_CLASSES.xl} ${CONTROL_TONE_CLASSES[persistentControl ? 'ghost' : 'default']}`} onClick={event => {
        if (event.target instanceof Element && !event.target.closest('button, input, select, a')) {
          if (persistentControl && !openRequestedRef.current) openSearch();
          inputRef.current?.focus({ preventScroll: true });
        }
      }}>
        <Search className={`studio-search-leading-icon ${textTones.muted}`} aria-hidden="true" />
        <div className="studio-search-tokens" aria-label="Search scope">
          {tokensOverride === undefined ? <>{scope !== 'all' && org ? <StudioSearchScopeChip className="studio-search-chip" title={org.name}>
            <Text as="span" variant="captionStrong" tone="secondary">{org.name}</Text><IconButton variant="ghost" tone="muted" size="xs" aria-label="Search all orgs" title="Search all orgs" onPress={() => changeScope('all', true)}><Xmark aria-hidden="true" /></IconButton>
          </StudioSearchScopeChip> : null}
          {scope === 'space' && space ? <>
            {org ? <Text as="span" variant="caption" tone="subtle" className="studio-search-separator" aria-hidden="true">/</Text> : null}
            <StudioSearchScopeChip className="studio-search-chip" title={space.name}>
              <Text as="span" variant="captionStrong" tone="secondary">{space.name}</Text><IconButton variant="ghost" tone="muted" size="xs" aria-label={org ? `Search within ${org.name}` : 'Search all orgs'} title={org ? `Search within ${org.name}` : 'Search all orgs'} onPress={() => changeScope(org ? 'org' : 'all', true)}><Xmark aria-hidden="true" /></IconButton>
            </StudioSearchScopeChip>
          </> : null}
          {scope === 'all' ? <StudioSearchScopeChip className="studio-search-all"><Text as="span" variant="captionStrong" tone="muted">All orgs</Text></StudioSearchScopeChip> : null}</> : tokensOverride}
        </div>
        <div className="studio-search-entry">
          <Input ref={inputRef} unstyled className={CONTROL_TEXT_SIZE_CLASSES.sm} type="search" autoFocus={!persistentControl} value={query} maxLength={200}
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
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Backspace' && query.length === 0 && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && scope !== 'all') {
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
      <span className="studio-search-close-slot" data-search-closed={!open || undefined} inert={!open || undefined} aria-hidden={!open || undefined}>
        <Button preset="toolbar" variant="ghost" tone="muted" className="studio-search-close" aria-label="Close search" title="Close search"
          isDisabled={!open} onPress={() => closeSearch()}>
          <Xmark aria-hidden="true" /><span className="studio-search-done" aria-hidden="true">Done</span>
        </Button>
      </span>
    </div>
  ) : (
    iconOnly ? <IconButton ref={triggerRef} variant="ghost" tone="muted"
      className="studio-search-trigger-icon" aria-label={`Search ${scopeName}`} title={`Search ${scopeName}`}
      aria-expanded={false} data-testid="studio-search-trigger" onPress={openSearch}>
      <Search aria-hidden="true" />
    </IconButton> : <Button ref={triggerRef} preset="inline" variant="ghost" tone="muted"
      className="studio-search-trigger" aria-label={`Search ${scopeName}`} title={`Search ${scopeName}`}
      aria-expanded={false} data-testid="studio-search-trigger" icon={<Search aria-hidden="true" />} onPress={openSearch}>
      Search…
    </Button>
  );
  const results: ReactNode = open ? (
    <section className={`studio-search-panel${fullPage ? ' studio-search-page' : ''}`} aria-labelledby={titleId} onKeyDown={onSearchKeyDown}>
      <div className="studio-search-scope-header">
        <div className="studio-search-heading">
          <Text as="h2" variant={fullPage ? "title" : "captionStrong"} tone={fullPage ? "primary" : "muted"} id={titleId} className="studio-search-scope">{fullPage ? 'Search results' : scope === 'all' ? 'Search across all orgs' : `Search in ${scopeName}`}</Text>
          {fullPage ? <Text as="span" variant="caption" tone="muted" className="studio-search-count">{matches.length} {matches.length === 1 ? 'result' : 'results'}</Text> : null}
        </div>
        <div className="studio-search-scope-select"><Text as="span" variant="caption" tone="muted">Scope</Text><Select native size="xs" tone="muted" fullWidth={false} aria-label="Search scope" value={scope} onChange={event => changeScope(event.target.value as StudioSearchScope)}>
          {space ? <option value="space">Current space</option> : null}
          {org ? <option value="org">Current org</option> : null}
          <option value="all">All orgs</option>
        </Select></div>
      </div>
      <Text variant="captionSmall" tone="muted" id={scopeHintId} className="studio-search-hint">Backspace with an empty query broadens scope.</Text>
      <div ref={resultsScrollRef} id={resultsId} className="studio-search-results" data-testid="studio-search-results" aria-busy={loading || Boolean(loadingMoreMessages)}>
        {loading ? <Text variant="bodyCompact" tone="muted" className="studio-search-status" role="status">Searching…</Text> : null}
        {error ? <div className="studio-search-status studio-search-error" role="alert">
          <Text variant="bodyCompact" tone="muted">{error}</Text>
          {onRetry ? <Button preset="inline" variant="outline" onPress={onRetry}>Retry search</Button> : null}
        </div> : null}
        <span className="studio-search-sr-only" role={loading ? undefined : "status"}>{matches.length} {matches.length === 1 ? 'result' : 'results'}</span>
        {GROUPS.map(group => {
          const groupResults = visibleMatches.filter(result => result.group === group);
          if (!groupResults.length) return null;
          const Icon = GROUP_ICONS[group];
          const headingId = `${resultsId}-${group.toLowerCase()}`;
          return <section key={group} aria-labelledby={headingId}>
            <Text as="h3" variant="caption" tone="muted" id={headingId}><Text as="span" variant="captionStrong" tone="muted">{group}</Text>{' '}
              {group === 'Messages' ? <Text as="span" variant="caption" tone="muted">Newest first</Text>
                : group === 'Chats' ? <Text as="span" variant="caption" tone="muted">Recent activity</Text> : null}
            </Text>
            {groupResults.map(result => <Button preset="inline" variant="ghost" key={result.id}
              ref={element => {
                if (element) resultRefs.current.set(result.id, element);
                else resultRefs.current.delete(result.id);
              }}
              className="studio-search-result" data-testid={`studio-search-result-${result.id}`}
              onKeyDown={event => onResultKeyDown(event, visibleMatches.indexOf(result))}
              onPress={() => {
                onBeforeResultActivate?.({ query, scope, scrollTop: resultsScrollRef.current?.scrollTop ?? 0,
                  resultId: result.id, resultLimit, messagePageCount, spacePageCount });
                closeSearch(false);
                result.activate();
              }}>
              <Icon aria-hidden="true" />
              <StudioSearchResultCopy title={result.title} description={result.description} message={result.message} />
            </Button>)}
          </section>;
        })}
        {visibleMatches.length < matches.length ? <Button preset="inline" variant="ghost" tone="accent" className="studio-search-more" onPress={() => setResultPage({ key: resultPageKey, limit: resultLimit + 100 })}>
          Show {Math.min(100, matches.length - visibleMatches.length)} more results ({visibleMatches.length} of {matches.length} shown)
        </Button> : null}
        {remainingSpaces > 0 ? <Button preset="inline" variant="ghost" tone="accent" className="studio-search-more" isPending={loading} onPress={onLoadMoreSpaces}>
          {loading ? 'Searching spaces…' : `Search more spaces (${remainingSpaces} remaining)`}
        </Button> : null}
        {hasMoreMessages ? <Button preset="inline" variant="ghost" tone="accent" className="studio-search-more" isPending={loadingMoreMessages} onPress={onLoadMoreMessages}>
          {loadingMoreMessages ? 'Loading more messages…' : 'Load more message results'}
        </Button> : null}
        {!matches.length && !loading && !error ? <Text variant="body" tone="muted" className="studio-search-empty">{remainingSpaces > 0 ? "No results in the spaces searched so far. Search more spaces to continue." : "No results in this scope. Try another query or a wider scope."}</Text> : null}
        <Text as="footer" variant="captionSmall" tone="muted" className="studio-search-footer">{notice ? <span>{notice}</span> : null}<span>↑ ↓ to move · Enter to open</span></Text>
      </div>
    </section>
  ) : null;
  return { open, openSearch, closeSearch, changeScope, renderControl, results, scope, query };
}
