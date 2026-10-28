import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserSessionModal } from "../../../src/screens/studio/components/BrowserSessionModal";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "runtime-limit";
const compact = params.get("layout") === "compact";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

declare global {
  interface Window {
    __browserRecoveryReview: {
      surface: string;
      disconnected: boolean;
      discoveryCount: number;
      ensureCount: number;
      stopCalls: Array<{ runtimeId: string; reason: string }>;
      connectionError: string;
      finishStop: (fail?: boolean) => void;
      hooks: { createElement: typeof createElement; useEffect: typeof useEffect; useRef: typeof useRef };
    };
  }
}
window.__browserRecoveryReview = {
  surface, disconnected: false, discoveryCount: 0, ensureCount: 0, stopCalls: [],
  connectionError: "The browser could not reach its machine. Your messages are still available. Check your connection and try opening the browser again.",
  finishStop: () => {},
  hooks: { createElement, useEffect, useRef },
};
const noop = () => {};

function Review() {
  const [open, setOpen] = useState(true);
  return <main className="browser-recovery-review">
    <header><strong>Browser recovery · {params.get("version") === "before" ? "Before" : "After"}</strong><span>Production browser modal · Inert service and viewer boundaries</span></header>
    <section aria-label="Browser recovery preview" className={`browser-recovery-stage ${compact ? "is-compact" : ""}`}>
      {!open ? <p data-testid="review-browser-hidden">Browser hidden. Your chat remains available.</p> : null}
      <BrowserSessionModal isOpen={open} onOpenChange={setOpen}
        projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" currentUserId="review-user"
        preferRuntimeId={null} resumeRuntimeId={surface === "reconnecting" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : null}
        browserSessionId="review-session" presentation="docked" fillContainer={!compact}
        canControlBrowser sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
        sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
        sharedBrowserChrome={{ compact: true, resolved: true, pendingAction: null, error: null,
          pages: [{ id: "review-page", url: "https://notes.example.test", host: "notes.example.test", label: "Project notes", title: "Project notes", isActive: true }],
          onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Review />);
