import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NavArrowLeft, NavArrowRight, RefreshDouble } from 'iconoir-react';
import { StatusProvider } from '../../../src/status/StatusProvider';
import { Status } from '../../../src/status/Status';
import { useStatus } from '../../../src/status/useStatus';
import { Button } from '../../../src/components/Button';
import { Input } from '../../../src/components/Input';
import { InlineNotice, type InlineNoticeTone } from '../../../src/components/InlineNotice';
import { BrowserChromeShell, BrowserStatusPill } from '../../../src/screens/studio/components/BrowserChromeShell';
import { BrowserSessionRecovery, BrowserSessionReconnecting } from '../../../src/screens/studio/components/BrowserSessionRecovery';
import { PreviewFeedbackLane } from '../../../src/screens/studio/components/previewHost/PreviewFeedback';
import type { StatusToastOptions } from '../../../src/status/StatusProvider';
import { WorkspaceAvailabilityProvider, useWorkspaceAvailability } from '../../../src/workspace/WorkspaceAvailabilityProvider';
import { WorkspaceAvailabilityBanner } from '../../../src/workspace/WorkspaceAvailabilityBanner';
import '../../../src/styles/tailwind.css';
import './review.css';

const query = new URLSearchParams(location.search);
const surface = query.get('surface') ?? 'toast-warning';
const long = query.get('text') !== 'short';
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark');
const counters = { retry: 0, dismiss: 0, stop: 0, shown: 0, closed: 0, probes: 0, recovered: 0, undo: 0, send: 0, cancel: 0 };
let probeKind = query.get('issue') ?? 'connection';
if (query.get('safeArea') === '1') {
  for (const [side, value] of Object.entries({top: 28, right: 20, bottom: 24, left: 20})) document.documentElement.style.setProperty(`--instafy-safe-area-inset-${side}`, `${value}px`);
}
if (query.get('textScale') === '2') document.documentElement.style.fontSize = '200%';
let pendingProbe: ((value: {kind: string}) => void) | null = null;
let nextProbePending = false;
(window as Window & { __reviewProbe: () => Promise<unknown> }).__reviewProbe = async () => {
  counters.probes++;
  if (nextProbePending) {
    nextProbePending = false;
    return new Promise(resolve => { pendingProbe = resolve; });
  }
  return { kind: probeKind };
};
const api: Record<string, unknown> = { counters, surface, getState: () => ({ surface, counters: {...counters}, probeKind, pendingProbe: !!pendingProbe }) };
(window as Window & { __review: typeof api }).__review = api;

const messages: Record<string, string> = {
  'toast-warning': long ? 'Your changes have not synced yet. Keep this page open while Instafy reconnects to your workspace.' : 'Your changes have not synced yet.',
  'toast-error': long ? 'Couldn’t save your changes. The workspace connection was interrupted. Try again once your connection is restored.' : 'Couldn’t save your changes.',
  'toast-action': long ? 'Couldn’t connect to the workspace. Your latest changes are still here. Check your internet connection, then try again.' : 'Couldn’t connect to the workspace.',
  'toast-unbroken': 'Couldn’t open https://example.com/preview/this-is-a-very-long-unbroken-project-name-and-path-that-keeps-going-without-any-spaces-or-line-breaks?workspace=review-and-another-long-identifier',
  confirmation: long ? 'Link copied to clipboard' : 'Copied',
};

function WorkspaceShift({ children }: { children: React.ReactNode }) {
  const availability = useWorkspaceAvailability();
  useEffect(() => {
    api.triggerWorkspaceFailure = (kind = 'connection') => { probeKind = kind; availability.reportFailure(); };
    api.workspaceSetResult = (kind: string) => { probeKind = kind; };
    api.workspaceRetry = () => availability.retry();
    api.workspaceHoldNext = () => { nextProbePending = true; };
    api.workspaceFinish = (kind = 'available') => { probeKind = kind; pendingProbe?.({kind}); pendingProbe = null; };
    api.workspaceState = () => ({issue: availability.issue, checking: availability.checking, recoveryVersion: availability.recoveryVersion});
  }, [availability]);
  return <>{children}</>;
}

function Workspace() {
  const availability = useWorkspaceAvailability();
  const { reportFailure } = availability;
  useEffect(() => { reportFailure(); }, [reportFailure]);
  useEffect(() => {
    api.workspaceRetry = () => { counters.retry++; availability.retry(); };
    api.workspaceSetResult = (kind: string) => { probeKind = kind; };
    api.workspaceHoldNext = () => { nextProbePending = true; };
    api.retryFinish = (kind = 'available') => { probeKind = kind; pendingProbe?.({kind}); pendingProbe = null; };
    api.workspaceState = () => ({ issue: availability.issue, checking: availability.checking, recoveryVersion: availability.recoveryVersion });
    counters.recovered = availability.recoveryVersion;
  }, [availability]);
  return <><WorkspaceAvailabilityBanner /><div className="review-workspace-content"><h1>Website workspace</h1><p className="review-label">Local review context</p><div className="review-controls"><Button data-testid="studio-context-workspace-focus" variant="secondary">Open files</Button><Button variant="ghost">Back to chat</Button></div></div></>;
}

function Review() {
  const { showStatus, hideStatus } = useStatus();
  const [feedback, setFeedback] = useState(surface === 'browser-feedback' ? (long ? 'Couldn’t open this address. Check that the address is correct and that the site allows access from this browser, then try again.' : 'Couldn’t open this address. Try again.') : null);
  const [visible, setVisible] = useState(true);
  const [approval, setApproval] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [lastAction, setLastAction] = useState('Ready');
  const [toastEpoch, setToastEpoch] = useState(0);
  const [active, setActive] = useState(true);
  const [, rerender] = useState(0);
  const dismiss = useCallback(() => { counters.dismiss++; setVisible(false); setLastAction('Dismissed'); }, []);
  const stop = useCallback(() => { counters.stop++; setVisible(false); setLastAction('Location sharing stopped'); }, []);
  const retry = useCallback(() => { counters.retry++; setRetrying(true); setLastAction('Retry requested'); }, []);
  const triggerToast = useCallback((kind = surface, override?: string, duration?: number, extra: StatusToastOptions = {}) => {
    const actualDuration = duration ?? (query.has('timeout') ? Number(query.get('timeout')) : kind === 'confirmation' ? 60000 : 0);
    showStatus(override ?? messages[kind] ?? messages['toast-warning'], kind === 'confirmation' ? 'success' : kind === 'toast-warning' ? 'warning' : 'error', actualDuration, {
      id: 'review-toast', presentation: kind === 'confirmation' ? 'confirmation' : 'default',
      ...(kind === 'toast-action' ? {actionLabel: 'Retry', onAction: retry} : {}),
      onShow: () => { counters.shown++; }, onClose: () => { counters.closed++; }, ...extra,
    });
  }, [showStatus, retry]);
  useEffect(() => {
    api.triggerToast = triggerToast;
    api.copy = () => triggerToast('confirmation', 'Copied', 2000);
    api.undo = () => showStatus('Item removed.', 'info', 0, {actionLabel: 'Undo', onAction: () => {counters.undo++;}, id:'review-undo'});
    api.recovery = () => showStatus('Couldn’t save your changes. They’re still here. Reconnect, then retry.', 'error', 5000, {
      id: 'review-recovery', behavior: {kind: 'action-required'}, actionLabel: 'Retry', onAction: retry,
    });
    api.information = (message = 'Your export is ready.') => showStatus(message as string, 'info', 5000, {
      id: 'review-information', behavior: {kind: 'informational'}, forceVisible: true,
    });
    api.deadlineUndo = () => showStatus('Chat moved to trash.', 'info', 6000, {
      id: 'review-deadline', behavior: {kind: 'deadline', expiresAt: Date.now() + 6000},
      actionLabel: 'Undo', onAction: () => {counters.undo++; setLastAction('Undo requested');},
    });
    api.hide = (id?: string) => hideStatus(id);
    api.rerender = () => rerender(value => value + 1);
    api.setActive = setActive;
    api.showPreview = () => {setVisible(true); setApproval(true); setToastEpoch(value => value + 1);};
    api.clear = () => { hideStatus(); setVisible(false); setFeedback(null); };
    api.setFeedback = setFeedback;
    api.reset = () => { setVisible(true); setRetrying(false); setToastEpoch(value => value + 1); triggerToast(); };
    if (surface !== 'workspace') api.retryFinish = () => { setRetrying(false); setLastAction('Retry completed'); };
    api.getState = () => ({ surface, counters: {...counters}, feedback, visible, retrying, lastAction, probeKind, pendingProbe: !!pendingProbe });
  }, [triggerToast, hideStatus, showStatus, feedback, visible, retrying, lastAction]);
  useEffect(() => { if (surface.startsWith('toast-') || surface === 'confirmation') triggerToast(); }, [triggerToast]);
  const browser = surface.startsWith('browser-') || ['location', 'location-blocked', 'location-approval', 'follow'].includes(surface) || query.get('workspace') === '1';
  return <>
    <header className="review-top"><span>Instafy</span><span className="review-label">Status review</span></header>
    <main className="review-main" data-review-surface={surface} style={query.has('paneWidth') ? {maxWidth: Number(query.get('paneWidth'))} : undefined}>
      {query.get('workspace') === '1' ? <WorkspaceAvailabilityBanner /> : null}
      {surface === 'workspace' ? <WorkspaceAvailabilityProvider scope={{projectId:'inert-review-project'}}><Workspace /></WorkspaceAvailabilityProvider> : browser ? <>
        <BrowserChromeShell label="Browser navigation" compact={query.get('compact') !== '0'}
          navigation={<><Button aria-label="Back" preset="toolbar" variant="ghost" icon><NavArrowLeft /></Button><Button aria-label="Forward" preset="toolbar" variant="ghost" icon><NavArrowRight /></Button><Button aria-label="Reload page" preset="toolbar" variant="ghost" icon onPress={retry}><RefreshDouble /></Button></>}
          address={<Input aria-label="Address" size="sm" radius="xl" defaultValue="https://example.com/visit" />}
          status={<BrowserStatusPill state="ready" />} feedback={feedback} feedbackTestId="browser-feedback" feedbackTone={query.get('tone') === 'success' ? 'success' : 'error'}
          onDismissFeedback={() => { counters.dismiss++; setFeedback(null); setLastAction('Browser message dismissed'); }} />
        <section className="review-browser" aria-label="Local browser page" data-testid="review-browser-pane" style={query.has('paneHeight') ? {height: Number(query.get('paneHeight')), minHeight: 0, overflow: 'hidden'} : undefined}>
          <div className="review-site"><p className="review-label">Inert page context</p><h1>Plan your next visit</h1><p>Explore nearby places and keep useful ideas together. This page provides context for the browser’s own feedback.</p><div className="review-site-panel"><h2>Saved places</h2><p>Your saved places will appear here.</p><div className="review-controls"><Button variant="secondary">Browse places</Button></div></div></div>
          {surface === 'browser-reconnecting' && visible ? <BrowserSessionReconnecting /> : null}
          {surface === 'browser-recovery' && visible ? <BrowserSessionRecovery presentation={query.get('presentation') === 'compact' ? 'compact' : 'overlay'} viewState={{kind: retrying ? 'opening' : 'failed',sentence: retrying ? 'Opening Instafy’s browser…' : 'Couldn’t reconnect to the browser. Try again.', action: retrying ? null : 'Try again'}} reason={retrying ? null : 'Local controlled connection failure'} onRetry={retry} onHide={dismiss} /> : null}
          <PreviewFeedbackLane key={toastEpoch} active={active}
            confirmation={surface === 'location-approval' && approval ? {line: long ? 'Add these nearby places to my visit plan and show me a walking route before booking any tickets or sharing my personal details.' : 'Plan a walking route', onSend: () => {counters.send++; setLastAction('Ask sent');}, onCancel: () => {counters.cancel++; setApproval(false); setLastAction('Ask cancelled');}} : undefined}
            location={(surface === 'location' || surface === 'location-approval') && visible ? {title: long ? 'Lisbon neighbourhoods, viewpoints, museums and places to explore' : 'City guide', onStop: stop, onDismiss: () => dismiss()} : undefined}
            blockedLocation={surface === 'location-blocked' && visible ? {onDismiss: () => dismiss()} : undefined}
            follow={surface === 'follow' && visible ? {text: long ? 'Alexandra stopped presenting the Lisbon neighbourhood guide. You can continue exploring on your own.' : 'Kim stopped presenting'} : undefined} />
        </section>
      </> : surface === 'inline-notice' ? <div className="review-inline"><InlineNotice role="alert" tone={query.get('tone') as InlineNoticeTone || 'warning'} title="Connection interrupted" actions={<Button variant="secondary" preset="inline" isPending={retrying} onPress={retry}>Retry</Button>}>{long ? 'The workspace connection was interrupted while saving your latest changes. Keep this page open and try again when your connection returns.' : 'Couldn’t save your changes.'}</InlineNotice></div> : <div className="review-page-content"><p className="review-label">Local workspace context</p><h1>Website workspace</h1><p>Keep working with your files and conversations. Feedback appears near the top of the workspace.</p><div className="review-controls"><Button data-testid="review-primary" variant="secondary" onPress={() => triggerToast()}>Show message again</Button><Button data-testid="review-secondary" variant="ghost">Open files</Button></div>{surface === 'behavior' ? <div className="review-controls"><Button variant="secondary" onPress={() => (api.recovery as () => void)()}>Recovery error</Button><Button variant="secondary" onPress={() => (api.information as () => void)()}>Information</Button><Button variant="secondary" onPress={() => (api.deadlineUndo as () => void)()}>Six-second Undo</Button><Button variant="ghost" onPress={() => (api.copy as () => void)()}>Copy</Button></div> : null}</div>}
    </main>
    <footer className="review-footer"><output data-testid="review-action-log">{lastAction}</output><p>Production components · local inert fixture · {surface} · {query.get('theme') === 'dark' ? 'dark' : 'light'}</p></footer>
    <Status />
  </>;
}
createRoot(document.getElementById('root')!).render(<StatusProvider>{query.get('workspace') === '1' ? <WorkspaceAvailabilityProvider scope={{projectId:'inert-review-project'}}><WorkspaceShift><Review /></WorkspaceShift></WorkspaceAvailabilityProvider> : <Review />}</StatusProvider>);
