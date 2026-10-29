import { recoveryBoundaries } from "../browser-recovery/boundaries";

/** Only transport/service boundaries are inert; all visible controls are production components. */
export const browserKeyboardStatusBoundaries: Record<string, string> = {
  ...recoveryBoundaries,
  "/src/sdk/instafy": `
    const review = () => window.__browserKeyboardStatusReview;
    const token = { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 };
    const runtime = { runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", origin: { originId: "review-origin", endpoint: token.endpoint, protocols: ["http"] } };
    export const controllerClient = {
      core: { enabled: true, baseUrl: "" },
      runtimes: {
        fetchStatus: async () => { const state = review(); state.discoveryCount += 1; return { runtimes: state.surface === "shared-connected" ? [runtime] : [] }; },
        ensure: async () => { review().ensureCount += 1; return new Promise(() => {}); },
        stop: async () => { review().stopCount += 1; return { statusChanged: true }; },
        stopIfIdle: async () => ({ statusChanged: false })
      },
      browserProfiles: { fetchStatus: async () => ({ success: true, status: { enabled: false } }) },
      browserSessions: { fetchPages: async () => ({ pages: [] }), isUnavailableError: () => false, isHostRefusedError: () => false },
      workspace: { origin: { requestAccessToken: async () => token, requestAccessTokenResult: async () => ({ ok: true, token }) } }
    };
  `,
  "/src/screens/studio/components/CdpScreencastViewer.tsx": `
    export function CdpScreencastViewer(props) {
      const { useEffect, useRef, createElement } = window.__browserKeyboardStatusReview.hooks;
      const latest = useRef(props); latest.current = props;
      useEffect(() => { window.__browserKeyboardStatusReview.viewerConnections += 1; latest.current.onConnected(); }, []);
      return createElement("div", { "data-testid": "review-browser-page", className: "review-page" },
        createElement("span", { className: "review-page-eyebrow" }, "PROJECT NOTES"),
        createElement("h1", null, "A quieter workspace"),
        createElement("p", null, "Keep the browser open while you work. This page is an inert local preview; no remote session is running."),
        createElement("label", null, "Notes", createElement("div", { className: "review-page-field" }, "Draft your next idea…")));
    }
  `,
};
browserKeyboardStatusBoundaries["/src/sdk/instafy/index.ts"] = browserKeyboardStatusBoundaries["/src/sdk/instafy"]!;
