import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserSessionModal } from "../../../src/screens/studio/components/BrowserSessionModal";
import { BrowserLocationOptions, PersonalBrowserSurface } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import { review } from "./syntheticTransport";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => {};
const model = {
  agentPhase: "idle", agentError: null, available: true, checked: true,
  clearDataError: null, clearDataState: "idle", clearNavigationError: noop, clearData: async () => null,
  close: async () => null, goBack: async () => null, goForward: async () => null,
  navigate: async () => null, navigationError: null, ownerId: "review-owner", reload: async () => null,
  recovering: false, retryOpen: noop, retryAgentControl: async () => null,
  preferredApprovalMode: "ask", setPreferredApprovalMode: noop,
  runtimeOverride: null, setAgentControlEnabled: async () => null,
  status: { supported: true, enabled: true, state: "ready", visible: true, url: "https://notes.example.test", canGoBack: false, canGoForward: false, ownerId: "review-owner", projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", approvalModes: ["ask", "routine"], agentControlEnabled: false, humanControlReady: true, approvalMode: "ask" },
} as unknown as Parameters<typeof PersonalBrowserSurface>[0]["model"];

function Review() {
  const [mode, setMode] = useState<"shared" | "personal">("shared");
  const selector = <BrowserLocationOptions checked mode={mode} personalAvailable onModeChange={next => { review.mode = next; setMode(next); }} />;
  return <main className="browser-switch-review">
    <header><strong>Browser switching · {params.get("version") === "before" ? "Before" : "After"}</strong><span>Production controls · Synthetic pixel transport and native bridge</span><small>Narrow Desktop window, not a mobile native browser. Personal checks cover bridge ordering, not Electron paint.</small></header>
    <section aria-label="Browser switching preview" className="browser-switch-review-stage">
      <PersonalBrowserSurface active={mode === "personal"} compactChrome model={model} locationOptions={mode === "personal" ? selector : null} />
      <div className={mode === "shared" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <BrowserSessionModal isOpen onOpenChange={noop} projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          currentUserId="review-user" preferRuntimeId={null} resumeRuntimeId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          browserSessionId="review-session" presentation="docked" fillContainer canControlBrowser
          sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={params.get("fallback") === "1" ? ["rfb", "cdp-screencast"] : ["rfb"]}
          transportActive={mode === "shared"} locationOptions={mode === "shared" ? selector : null}
          sharedBrowserChrome={{ compact: true, resolved: true, pendingAction: null, error: null,
            pages: [{ id: "review-page", url: "https://notes.example.test", host: "notes.example.test", label: "Project notes", title: "Project notes", isActive: true }],
            onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />
      </div>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review />);
