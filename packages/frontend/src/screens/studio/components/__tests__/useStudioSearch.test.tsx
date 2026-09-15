// @vitest-environment jsdom

import { act, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useStudioSearch,
  type StudioSearchProps,
  type StudioSearchRecord,
} from '../useStudioSearch';

describe('Studio search', () => {
  let container: HTMLDivElement;
  let root: Root;
  let records: StudioSearchRecord[];
  let props: StudioSearchProps;
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const commits: Array<{ scopeKey: string; open: boolean; query: string | null; results: string[] }> = [];

  function Harness({ tokensOverride, ...hookProps }: StudioSearchProps & { tokensOverride?: ReactNode }) {
    const search = useStudioSearch(hookProps);
    useLayoutEffect(() => {
      commits.push({
        scopeKey: hookProps.scopeKey,
        open: search.open,
        query: container.querySelector<HTMLInputElement>('input')?.value ?? null,
        results: resultIds(),
      });
    });
    return <>{search.renderControl(false, tokensOverride)}{search.results}</>;
  }

  function FocusHarness({
    internalTrigger = 'absent',
    ...hookProps
  }: StudioSearchProps & { internalTrigger?: 'absent' | 'hidden' | 'inert' | 'zero-area' }) {
    const returnFocusRef = useRef<HTMLButtonElement>(null);
    const search = useStudioSearch({ ...hookProps, fullPage: true, returnFocusRef });
    return <>
      <button ref={returnFocusRef} data-testid="external-search-trigger" onClick={search.openSearch}>Search this workspace</button>
      <button data-testid="old-drawer-trigger">Previous navigation control</button>
      <button data-testid="destination">Opened workspace</button>
      {search.open ? search.renderControl() : internalTrigger !== 'absent' ? (
        <div hidden={internalTrigger === 'hidden'} inert={internalTrigger === 'inert'}
          data-zero-area={internalTrigger === 'zero-area' || undefined}>
          {search.renderControl()}
        </div>
      ) : null}
      {search.results}
    </>;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    commits.length = 0;
    const record = (
      id: string,
      group: StudioSearchRecord['group'],
      orgId: string,
      spaceId: string | null,
    ): StudioSearchRecord => ({
      id,
      title: 'Report investigation',
      description: `${orgId} / ${spaceId ?? 'organization'}`,
      keywords: 'report',
      group,
      orgId,
      spaceId,
      activate: vi.fn(),
    });
    // Deliberately interleave groups and reuse both titles and a space ID across
    // organizations: scope matching and keyboard order must use their full context.
    records = [
      record('file-current', 'Files', 'org-a', 'space-a'),
      record('chat-other-org', 'Chats', 'org-b', 'space-a'),
      record('settings-org', 'Settings', 'org-a', null),
      record('chat-sibling', 'Chats', 'org-a', 'space-b'),
      record('action-current', 'Actions', 'org-a', 'space-a'),
      record('chat-current', 'Chats', 'org-a', 'space-a'),
      record('file-other-org', 'Files', 'org-b', 'space-c'),
    ];
    props = {
      scopeKey: 'account-1:org-a:space-a',
      org: { id: 'org-a', name: 'Alpha team' },
      space: { id: 'space-a', name: 'Core workspace' },
      records,
      onOpen: vi.fn(),
    };
  });

  it('bounds rendered results and keeps later matches searchable', async () => {
    const many = Array.from({ length: 240 }, (_, index) => ({ ...records[5], id: `chat-${index}`, title: index === 239 ? 'Unique later chat' : `Report ${index}` }));
    await act(async () => root.render(<Harness {...props} records={many} persistentControl />));
    await act(async () => container.querySelector<HTMLInputElement>('input')!.focus());
    expect(resultIds()).toHaveLength(100);
    expect(container.textContent).toContain('240 results');
    await act(async () => container.querySelector<HTMLButtonElement>('.studio-search-more')!.click());
    expect(resultIds()).toHaveLength(200);
    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unique later');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(resultIds()).toEqual(['chat-239']);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.restoreAllMocks();
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function resultIds() {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="studio-search-result-"]'))
      .map(element => element.dataset.testid!.replace('studio-search-result-', ''));
  }
  function input() {
    return container.querySelector<HTMLInputElement>('[data-testid="studio-search-input"]')!;
  }
  function scopeSelect() {
    return container.querySelector<HTMLSelectElement>('select[aria-label="Search scope"]')!;
  }
  function button(label: string) {
    const result = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(element => element.getAttribute('aria-label') === label);
    expect(result, `button labelled ${label}`).toBeDefined();
    return result!;
  }
  async function render(nextProps = props) {
    props = nextProps;
    await act(async () => root.render(<Harness {...props} />));
  }
  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }
  async function open() {
    await render();
    await click(container.querySelector<HTMLButtonElement>('[data-testid="studio-search-trigger"]')!);
    expect(document.activeElement).toBe(input());
  }
  async function key(key: string, options: KeyboardEventInit = {}, target: HTMLElement = input()) {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...options,
    })));
  }
  async function enterQuery(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input().value).toBe(value);
  }
  async function selectScope(value: string) {
    await act(async () => {
      scopeSelect().value = value;
      scopeSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  function expectNoActivation() {
    for (const record of records) expect(record.activate).not.toHaveBeenCalled();
  }
  function prepareFocusFrames() {
    // JSDOM has no layout; model visibility explicitly, including a mounted but
    // zero-sized background trigger that must not win restoration.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      const rects = this.closest('[data-zero-area="true"]') ? [] : [new DOMRect(0, 0, 100, 40)];
      return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList;
    });
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      pending.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { pending.delete(id); });
    return async () => {
      await act(async () => {
        const callbacks = [...pending.values()];
        pending.clear();
        callbacks.forEach(callback => callback(performance.now()));
      });
    };
  }
  async function openFullPage(internalTrigger: 'absent' | 'hidden' | 'inert' | 'zero-area' = 'absent') {
    await act(async () => root.render(<FocusHarness {...props} internalTrigger={internalTrigger} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="external-search-trigger"]')!;
    await click(trigger);
    expect(document.activeElement).toBe(input());
    return trigger;
  }

  it('broadens an empty query from space to organization to all without activating a result', async () => {
    const startingUrl = window.location.href;
    await open();
    expect(scopeSelect().value).toBe('space');
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);

    await key('Backspace');
    expect(scopeSelect().value).toBe('org');
    expect(resultIds()).toEqual(['chat-sibling', 'chat-current', 'file-current', 'settings-org', 'action-current']);
    expect(document.activeElement).toBe(input());

    await key('Backspace');
    expect(scopeSelect().value).toBe('all');
    expect(resultIds()).toEqual(['chat-other-org', 'chat-sibling', 'chat-current', 'file-current', 'file-other-org', 'settings-org', 'action-current']);
    await key('Backspace');
    expect(scopeSelect().value).toBe('all');
    expectNoActivation();
    expect(window.location.href).toBe(startingUrl);
    expect(props.onOpen).toHaveBeenCalledOnce();
  });

  it('keeps Backspace inside a nonempty query', async () => {
    await open();
    await enterQuery('report');
    await key('Backspace');
    // Synthetic keydown does not simulate the browser's character deletion.
    expect(input().value).toBe('report');
    expect(scopeSelect().value).toBe('space');
    expectNoActivation();
  });

  it.each([
    ['repeat', { repeat: true }],
    ['composition', { isComposing: true }],
    ['Alt', { altKey: true }],
    ['Control', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }],
  ] satisfies Array<[string, KeyboardEventInit]>)('does not broaden on %s Backspace', async (_label, options) => {
    await open();
    await key('Backspace', options);
    expect(scopeSelect().value).toBe('space');
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    expectNoActivation();
  });

  it('preserves query text while chips broaden and the visible scope selector narrows again', async () => {
    await open();
    await enterQuery('Report investigation');
    await click(button('Search within Alpha team'));
    expect(scopeSelect().value).toBe('org');
    expect(input().value).toBe('Report investigation');
    expect(document.activeElement).toBe(input());

    await selectScope('space');
    expect(input().value).toBe('Report investigation');
    await click(button('Search all orgs'));
    expect(scopeSelect().value).toBe('all');
    expect(container.querySelector('.studio-search-chip')).toBeNull();
    expect(input().value).toBe('Report investigation');

    await selectScope('org');
    expect(scopeSelect().value).toBe('org');
    expect(input().value).toBe('Report investigation');
    expectNoActivation();
  });

  it('clears query, open state, and old scope before a new account or workspace is painted', async () => {
    await open();
    await enterQuery('old query');
    await selectScope('all');
    commits.length = 0;
    await render({
      ...props,
      scopeKey: 'account-2:org-b:space-c',
      org: { id: 'org-b', name: 'Beta team' },
      space: { id: 'space-c', name: 'Other workspace' },
    });
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every(commit => !commit.open && commit.query === null && commit.results.length === 0)).toBe(true);
    expect(input()).toBeNull();
    await click(button('Search Other workspace'));
    expect(input().value).toBe('');
    expect(scopeSelect().value).toBe('space');
    expect(resultIds()).toEqual(['file-other-org']);
    expectNoActivation();
  });

  it('starts an empty team at organization scope and permits an explicit wider search', async () => {
    props = { ...props, scopeKey: 'empty-team', org: { id: 'org-empty', name: 'Empty team' }, space: null };
    await open();
    expect(scopeSelect().value).toBe('org');
    expect(resultIds()).toEqual([]);
    expect(container.textContent).toContain('No results in this scope.');
    expect(scopeSelect().querySelector('option[value="space"]')).toBeNull();
    await key('Backspace');
    expect(scopeSelect().value).toBe('all');
    expect(resultIds()).toHaveLength(records.length);
    expectNoActivation();
  });

  it('starts a global context at all organizations with no stale narrowing choices', async () => {
    props = { ...props, scopeKey: 'global-home', org: null, space: null };
    await open();
    expect(scopeSelect().value).toBe('all');
    expect(Array.from(scopeSelect().options).map(option => option.value)).toEqual(['all']);
    expect(resultIds()).toHaveLength(records.length);
    expectNoActivation();
  });

  it('traverses grouped visual result order even when input records are interleaved', async () => {
    await open();
    await selectScope('all');
    const expectedOrder = ['chat-other-org', 'chat-sibling', 'chat-current', 'file-current', 'file-other-org', 'settings-org', 'action-current'];
    expect(resultIds()).toEqual(expectedOrder);
    for (const id of expectedOrder) {
      await key('ArrowDown', {}, document.activeElement as HTMLElement);
      expect((document.activeElement as HTMLElement).dataset.testid).toBe(`studio-search-result-${id}`);
    }
    await key('ArrowDown', {}, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.testid).toBe('studio-search-result-chat-other-org');
    await key('ArrowUp', {}, document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(input());
    await key('ArrowUp');
    expect((document.activeElement as HTMLElement).dataset.testid).toBe('studio-search-result-action-current');
    await key('Home', {}, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.testid).toBe('studio-search-result-chat-other-org');
    await key('End', {}, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.testid).toBe('studio-search-result-action-current');
    expectNoActivation();
  });

  it('activates only the chosen record after broadening, despite duplicate result titles', async () => {
    await open();
    await selectScope('all');
    await click(container.querySelector<HTMLButtonElement>('[data-testid="studio-search-result-chat-other-org"]')!);
    expect(records.find(record => record.id === 'chat-other-org')!.activate).toHaveBeenCalledOnce();
    for (const record of records.filter(record => record.id !== 'chat-other-org')) expect(record.activate).not.toHaveBeenCalled();
  });

  it.each([
    ['Close', 'absent'],
    ['Escape', 'hidden'],
    ['Close', 'inert'],
    ['Escape', 'zero-area'],
  ] as const)('returns to the visible external trigger after %s when the internal trigger is %s', async (dismissal, internalTrigger) => {
    const flushFrame = prepareFocusFrames();
    const trigger = await openFullPage(internalTrigger);
    await flushFrame();
    if (dismissal === 'Close') await click(button('Close search'));
    else await key('Escape');
    expect(input()).toBeNull();
    // Model the old drawer's restoration taking place before our next frame.
    container.querySelector<HTMLButtonElement>('[data-testid="old-drawer-trigger"]')!.focus();
    await flushFrame();
    expect(document.activeElement).toBe(trigger);
    expectNoActivation();
  });

  it('does not return focus to a search trigger when a result opens its destination', async () => {
    const flushFrame = prepareFocusFrames();
    const trigger = await openFullPage('hidden');
    await flushFrame();
    const focusTrigger = vi.spyOn(trigger, 'focus');
    const destination = container.querySelector<HTMLButtonElement>('[data-testid="destination"]')!;
    const record = records.find(record => record.id === 'chat-current')!;
    vi.mocked(record.activate).mockImplementation(() => destination.focus());
    await click(container.querySelector<HTMLButtonElement>('[data-testid="studio-search-result-chat-current"]')!);
    expect(input()).toBeNull();
    await flushFrame();
    expect(record.activate).toHaveBeenCalledOnce();
    expect(focusTrigger).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(destination);
  });

  it('focuses full-page search after the closing drawer moves focus away from initial autofocus', async () => {
    const flushFrame = prepareFocusFrames();
    await openFullPage();
    const oldTrigger = container.querySelector<HTMLButtonElement>('[data-testid="old-drawer-trigger"]')!;
    oldTrigger.focus();
    expect(document.activeElement).toBe(oldTrigger);
    await flushFrame();
    expect(document.activeElement).toBe(input());
    expectNoActivation();
  });

  it.each(['scope', 'result'] as const)('preserves deliberate %s focus while the opening frame settles', async targetKind => {
    const flushFrame = prepareFocusFrames();
    await openFullPage();
    const target = targetKind === 'scope'
      ? scopeSelect()
      : container.querySelector<HTMLButtonElement>('[data-testid="studio-search-result-chat-current"]')!;
    target.focus();
    await flushFrame();
    expect(document.activeElement).toBe(target);
    expectNoActivation();
  });

  it('keeps a persistent input mounted without initial autofocus, then opens once for focus and click', async () => {
    props = { ...props, persistentControl: true };
    await render();
    const originalInput = input();
    expect(originalInput).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(resultIds()).toEqual([]);
    expect(originalInput.hasAttribute('aria-controls')).toBe(false);
    const closeButton = button('Close search');
    expect(closeButton.disabled).toBe(true);
    expect(closeButton.getAttribute('aria-hidden')).toBe('true');
    expect(closeButton.tabIndex).toBe(-1);
    expect(props.onOpen).not.toHaveBeenCalled();

    await act(async () => originalInput.focus());
    await click(originalInput);
    expect(input()).toBe(originalInput);
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    expect(props.onOpen).toHaveBeenCalledOnce();
  });

  it.each(['Close', 'Escape'] as const)('resets persistent search with %s and restores its same input without reopening', async dismissal => {
    const flushFrame = prepareFocusFrames();
    props = { ...props, persistentControl: true };
    await render();
    const originalInput = input();
    await act(async () => originalInput.focus());
    await enterQuery('report');
    await selectScope('all');
    if (dismissal === 'Close') {
      await act(async () => button('Close search').focus());
      await click(button('Close search'));
    } else await key('Escape');

    await flushFrame();
    expect(input()).toBe(originalInput);
    expect(document.activeElement).toBe(originalInput);
    expect(originalInput.value).toBe('');
    expect(originalInput.getAttribute('aria-label')).toContain('Core workspace');
    expect(resultIds()).toEqual([]);
    expect(button('Close search').disabled).toBe(true);
    expect(props.onOpen).toHaveBeenCalledOnce();

    await click(originalInput);
    expect(input()).toBe(originalInput);
    expect(scopeSelect().value).toBe('space');
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    expect(props.onOpen).toHaveBeenCalledTimes(2);
    expectNoActivation();
  });

  it('reopens a dismissed persistent search by typing into its already focused input', async () => {
    const flushFrame = prepareFocusFrames();
    props = { ...props, persistentControl: true };
    await render();
    const originalInput = input();
    await act(async () => originalInput.focus());
    await key('Escape');
    await flushFrame();
    expect(document.activeElement).toBe(originalInput);
    expect(resultIds()).toEqual([]);

    await enterQuery('report');
    expect(input()).toBe(originalInput);
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    expect(props.onOpen).toHaveBeenCalledTimes(2);
    expectNoActivation();
  });

  it('keeps supplied scope-menu buttons interactive before and during persistent search', async () => {
    const tokenAction = vi.fn();
    const tokens = <button type="button" data-testid="real-team-menu" onClick={tokenAction}>Alpha team menu</button>;
    props = { ...props, persistentControl: true };
    await act(async () => root.render(<Harness {...props} tokensOverride={tokens} />));
    const menu = container.querySelector<HTMLButtonElement>('[data-testid="real-team-menu"]')!;
    const originalInput = input();
    await click(menu);
    expect(tokenAction).toHaveBeenCalledOnce();
    expect(resultIds()).toEqual([]);
    expect(props.onOpen).not.toHaveBeenCalled();

    await act(async () => originalInput.focus());
    await enterQuery('report');
    await click(menu);
    expect(tokenAction).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="real-team-menu"]')).toBe(menu);
    expect(input()).toBe(originalInput);
    expect(input().value).toBe('report');
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    expect(props.onOpen).toHaveBeenCalledOnce();
    expectNoActivation();
  });

  it('publishes requests from interactions without fetching on mount or account reset', async () => {
    const onRequestChange = vi.fn();
    props = { ...props, persistentControl: true, onRequestChange };
    await render();
    expect(onRequestChange).not.toHaveBeenCalled();

    await act(async () => input().focus());
    await click(input());
    expect(onRequestChange.mock.calls).toEqual([[{ open: true, scope: 'space', query: '' }]]);
    await key('Backspace');
    expect(onRequestChange).toHaveBeenLastCalledWith({ open: true, scope: 'org', query: '' });
    await enterQuery('report');
    expect(onRequestChange).toHaveBeenLastCalledWith({ open: true, scope: 'org', query: 'report' });
    await key('Escape');
    expect(onRequestChange).toHaveBeenLastCalledWith({ open: false, scope: 'space', query: '' });

    onRequestChange.mockClear();
    await render({ ...props, scopeKey: 'different-account:global', org: null, space: null });
    expect(onRequestChange).not.toHaveBeenCalled();
    await click(input());
    expect(onRequestChange).toHaveBeenLastCalledWith({ open: true, scope: 'all', query: '' });
  });

  it('shows loading instead of an empty-state claim and exposes partial-index limits', async () => {
    props = { ...props, records: [], loading: true, notice: 'Files are available in the current space.' };
    await open();
    const results = container.querySelector('[data-testid="studio-search-results"]')!;
    expect(results.getAttribute('aria-busy')).toBe('true');
    expect(results.textContent).toContain('Searching…');
    expect(container.textContent).not.toContain('No results');
    expect(container.textContent).toContain('Files are available in the current space.');

    await render({ ...props, records, loading: false });
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    expect(results.getAttribute('aria-busy')).toBe('false');
    expect(container.textContent).not.toContain('Searching…');
  });

  it('retains available results during a failed refresh and provides the requested retry', async () => {
    const onRetry = vi.fn();
    props = { ...props, error: 'Could not refresh chat titles.', onRetry };
    await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh chat titles.');
    expect(resultIds()).toEqual(['chat-current', 'file-current', 'action-current']);
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(element => element.textContent === 'Retry search')!;
    await click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
    expectNoActivation();

    await render({ ...props, records: [] });
    expect(container.textContent).not.toContain('No results');
  });

  it('matches all query terms across titles, descriptions and keywords within the chosen scope', async () => {
    const currentChat = records.find(record => record.id === 'chat-current')!;
    currentChat.keywords = 'navigation overflow';
    await open();
    await enterQuery('  REPORT    OVERFLOW  ');
    expect(resultIds()).toEqual(['chat-current']);
    await enterQuery('Report org-b');
    expect(resultIds()).toEqual([]);
    await selectScope('all');
    expect(resultIds()).toEqual(['chat-other-org', 'file-other-org']);
    expectNoActivation();
  });
});
