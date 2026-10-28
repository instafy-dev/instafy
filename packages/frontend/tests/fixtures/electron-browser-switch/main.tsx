import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserSessionModal } from "../../../src/screens/studio/components/BrowserSessionModal";
import { BrowserLocationOptions, PersonalBrowserSurface } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import "./controlledShared";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => {};
const projectId = "11111111-1111-4111-8111-111111111111";
const profileUserId = "22222222-2222-4222-8222-222222222222";
const ownerId = "electron-switch-review";
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const session = { access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: profileUserId, exp: expiresAt })}.fixture-signature`, expires_at: expiresAt, user: { id: profileUserId } };
// Matches the established credential-free Electron fixture identity contract.
Object.assign(window, {
  __INSTAFY_TEST_SESSION__: () => session,
  __INSTAFY_SUPABASE__: { auth: {
    getSession: async () => ({ data: { session } }),
    refreshSession: async () => ({ data: { session } }),
  } },
});

function Review() {
  const [mode, setMode] = useState<"shared" | "personal">("shared");
  const [status, setStatus] = useState<InstafyDesktopPersonalBrowserStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const bridge = window.instafyDesktop;
    if (!bridge?.personalBrowserOpen) { setError("Open this explicit fixture in the built Electron app."); return; }
    const unsubscribe = bridge.onPersonalBrowserStatus?.(setStatus);
    void bridge.personalBrowserOpen({ projectId, profileUserId, ownerId, controllerUrl: location.origin, controllerAccessToken: session.access_token, url: `${location.origin}/native-page` }).then(setStatus).catch(reason => setError(String(reason)));
    return unsubscribe;
  }, []);
  const model = {
    agentPhase: "idle", agentError: null, available: true, checked: true,
    clearDataError: null, clearDataState: "idle", clearNavigationError: noop,
    clearData: () => window.instafyDesktop?.personalBrowserClearData?.({ ownerId }),
    close: () => window.instafyDesktop?.personalBrowserClose?.({ ownerId }),
    goBack: () => window.instafyDesktop?.personalBrowserGoBack?.({ ownerId }),
    goForward: () => window.instafyDesktop?.personalBrowserGoForward?.({ ownerId }),
    navigate: (url: string) => window.instafyDesktop?.personalBrowserNavigate?.({ ownerId, url }),
    navigationError: null, ownerId,
    reload: () => window.instafyDesktop?.personalBrowserReload?.({ ownerId }),
    recovering: false, retryOpen: noop, retryAgentControl: async () => null,
    preferredApprovalMode: "ask", setPreferredApprovalMode: noop, runtimeOverride: null,
    setAgentControlEnabled: (enabled: boolean) => window.instafyDesktop?.personalBrowserSetAgentControlEnabled?.({ ownerId, enabled }),
    status,
  } as unknown as Parameters<typeof PersonalBrowserSurface>[0]["model"];
  const selector = <BrowserLocationOptions checked mode={mode} personalAvailable onModeChange={setMode} />;
  return <main className="browser-switch-review" data-native-state={status?.state ?? "waiting"}>
    <header><strong>Electron browser switching</strong><span>Real native Personal browser · controlled Shared pixel transport</span><small>Production surfaces and Desktop preload/IPC. Narrow Desktop window; not mobile native browsing.</small>{error ? <p role="alert">{error}</p> : null}</header>
    <section aria-label="Browser switching preview" className="browser-switch-review-stage">
      <PersonalBrowserSurface active={mode === "personal"} compactChrome model={model} locationOptions={mode === "personal" ? selector : null} />
      <div className={mode === "shared" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <BrowserSessionModal isOpen onOpenChange={noop} projectId={projectId}
          currentUserId="review-user" preferRuntimeId={null} resumeRuntimeId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          browserSessionId="review-session" presentation="docked" fillContainer canControlBrowser
          sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={["rfb"]}
          transportActive={mode === "shared"} locationOptions={mode === "shared" ? selector : null}
          sharedBrowserChrome={{ compact: true, resolved: true, pendingAction: null, error: null,
            pages: [{ id: "review-page", url: "https://notes.example.test", host: "notes.example.test", label: "Project notes", title: "Project notes", isActive: true }],
            onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />
      </div>
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Review />);
