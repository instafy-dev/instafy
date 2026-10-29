import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserSessionModal } from "../../../src/screens/studio/components/BrowserSessionModal";
import { PersonalBrowserSurface } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import { RemoteBrowserMobileKeyboard } from "../../../src/screens/studio/components/RemoteBrowserMobileKeyboard";
import type { usePersonalBrowserBridge } from "../../../src/screens/studio/components/usePersonalBrowserBridge";
import type { RemoteBrowserVirtualInputMessage } from "../../../src/screens/studio/components/remoteBrowserInput";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "keyboard";
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
const longError = "The browser could not reopen the page on this device. Your chat and draft are still available. Check your connection, then try again. Diagnostic reference: personal-browser-connection-recovery-reference-0123456789abcdefghijklmnopqrstuvwxyz.";
type PersonalBrowserModel = ReturnType<typeof usePersonalBrowserBridge>;
const noop = () => {};
const asyncNoop = async () => null;

declare global {
  interface Window {
    __browserKeyboardStatusReview: {
      surface: string;
      messages: RemoteBrowserVirtualInputMessage[];
      occupiedHeight: number;
      discoveryCount: number;
      ensureCount: number;
      stopCount: number;
      viewerConnections: number;
      hideCount: number;
      retryCount: number;
      viewStates: Array<string | null>;
      finishRetry: () => void;
      hooks: { createElement: typeof createElement; useEffect: typeof useEffect; useRef: typeof useRef };
    };
  }
}
window.__browserKeyboardStatusReview = {
  surface, messages: [], occupiedHeight: 0, discoveryCount: 0, ensureCount: 0,
  stopCount: 0, viewerConnections: 0, hideCount: 0, retryCount: 0, viewStates: [], finishRetry: noop,
  hooks: { createElement, useEffect, useRef },
};
const review = window.__browserKeyboardStatusReview;

function PagePreview() {
  return <div className="review-page" data-testid="review-browser-page">
    <span className="review-page-eyebrow">PROJECT NOTES</span>
    <h1>A quieter workspace</h1>
    <p>Keep the browser open while you work. This page is an inert local preview; no remote session is running.</p>
    <label>Notes<div className="review-page-field">Draft your next idea…</div></label>
  </div>;
}

function KeyboardReview() {
  const inline = params.get("inline") === "1" || surface === "keyboard-inline";
  const onMessage = useCallback((message: RemoteBrowserVirtualInputMessage) => { review.messages.push(message); }, []);
  const onOccupiedHeightChange = useCallback((height: number) => { review.occupiedHeight = height; }, []);
  return <section className="review-keyboard-stage" aria-label="Remote browser keyboard preview" data-testid="keyboard-review-stage">
    {inline ? <div className="review-keyboard-toolbar"><span>Project notes</span>
      <RemoteBrowserMobileKeyboard enabled inlineTrigger onMessage={onMessage} onOccupiedHeightChange={onOccupiedHeightChange} />
    </div> : null}
    <PagePreview />
    {!inline ? <RemoteBrowserMobileKeyboard enabled onMessage={onMessage} onOccupiedHeightChange={onOccupiedHeightChange} /> : null}
    <p className="review-desktop-note">The remote keyboard is a touch utility; desktop uses the hardware keyboard.</p>
  </section>;
}

function PersonalReview() {
  const [recovering, setRecovering] = useState(surface === "personal-retrying");
  const isError = surface !== "personal-opening";
  review.finishRetry = () => setRecovering(false);
  const model: PersonalBrowserModel = {
    approvalModeChoice: "routine", preferredApprovalMode: "routine", setPreferredApprovalMode: noop,
    agentError: null, agentPhase: "ready", available: true, checked: true, clearDataError: null, clearDataState: "idle",
    clearNavigationError: noop, clearData: asyncNoop, close: asyncNoop, closeTab: asyncNoop,
    goBack: asyncNoop, goForward: asyncNoop, navigate: asyncNoop, navigationError: null,
    ownerId: "review-owner", pendingHandoff: null, readPage: asyncNoop, reload: asyncNoop,
    searchChoice: null, setSearchEngine: async () => undefined, selectTab: asyncNoop,
    recovering, retryAgentControl: asyncNoop,
    retryOpen: () => { review.retryCount += 1; setRecovering(true); },
    runtimeOverride: { runtimeId: "desktop-personal-review", runtimeDisplayName: "Personal Browser on this device", preferRuntime: false },
    setAgentControlEnabled: asyncNoop,
    status: {
      supported: true, enabled: true, state: isError ? "error" : "opening", visible: true,
      url: "https://notes.example.test", canGoBack: false, canGoForward: false,
      agentControlEnabled: false, ownerId: "review-owner", projectId: "review-project", runtimeId: "desktop-personal-review",
      ...(isError ? { error: longError } : {}),
    },
  };
  // Native bounds reports are inert; these states never present a native page.
  window.instafyDesktop = { notify: async () => undefined, personalBrowserSetBounds: async () => model.status! };
  return <section className="review-personal-stage" aria-label="Personal browser preview">
    <PersonalBrowserSurface active compactChrome model={model} />
  </section>;
}

function SharedReview() {
  const [open, setOpen] = useState(true);
  const connected = surface === "shared-connected";
  const onOpenChange = useCallback((next: boolean) => { if (!next) review.hideCount += 1; setOpen(next); }, []);
  const onViewStateChange = useCallback((state: string | null) => { review.viewStates.push(state); }, []);
  return <section className="review-status-stage" aria-label="Shared browser preview">
    {!open ? <p data-testid="review-browser-hidden">Browser hidden. Your chat remains available.</p> : null}
    <BrowserSessionModal isOpen={open} onOpenChange={onOpenChange} onViewStateChange={onViewStateChange}
      projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" currentUserId="review-user"
      preferRuntimeId={null} resumeRuntimeId={connected ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : null}
      browserSessionId="review-session" presentation="docked" fillContainer={connected}
      canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
      sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
      sharedBrowserChrome={{ compact: true, resolved: true, pendingAction: null, error: null,
        pages: [{ id: "review-page", url: "https://notes.example.test", host: "notes.example.test", label: "Project notes", title: "Project notes", isActive: true }],
        onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />
  </section>;
}

function Review() {
  return <main className="browser-keyboard-review">
    <header><strong>Browser keyboard and status · {params.get("version") === "before" ? "Before" : "After"}</strong>
      <span>Production components · Inert transport and native-host boundaries</span></header>
    {surface.startsWith("personal-") ? <PersonalReview /> : surface.startsWith("shared-") ? <SharedReview /> : <KeyboardReview />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Review />);
