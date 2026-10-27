/** Inert data/transport boundaries shared by the visual fixture and browser spec. */
export const browserSwitchBoundaries: Record<string, string> = {
  "/src/sdk/instafy": `
    const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const token = { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 };
    export const controllerClient = {
      core: { enabled: true, baseUrl: "" },
      runtimes: { fetchStatus: async () => ({ runtimes: [{ runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", origin: { originId: "review-origin", endpoint: token.endpoint, protocols: ["http"] } }] }) },
      browserProfiles: { fetchStatus: async () => ({ success: true, status: { enabled: false } }) },
      workspace: { origin: { requestAccessToken: async () => token, requestAccessTokenResult: async () => ({ ok: true, token }) } }
    };
  `,
  "/src/screens/studio/components/useSharedBrowserCollaboration.ts": `
    const participant = { id: "review-user", displayName: "You", kind: "human", role: "editor", canControl: true, joinedAt: 1, lastSeenAt: 1, pageId: "review-page", cursor: null };
    const client = { connectionStatus: "connected", participantId: participant.id, error: null, state: { participants: [participant], controlOwner: { kind: "human", participantId: participant.id }, requests: [], controlRequests: [], controllerParticipantId: participant.id } };
    const noop = () => {};
    export function useSharedBrowserCollaboration({ active }) {
      const review = window.__browserSwitchReview;
      const delay = Number(new URLSearchParams(location.search).get("rosterDelay") ?? 0);
      const [resolved, setResolved] = review.hooks.useState(delay === 0);
      review.hooks.useEffect(() => {
        setResolved(false);
        if (!active) return;
        if (delay === 0) { setResolved(true); return; }
        const timer = window.setTimeout(() => setResolved(true), delay);
        return () => window.clearTimeout(timer);
      }, [active, delay]);
      const ready = active && (delay === 0 || resolved);
      review.rosterState = ready ? "connected" : active ? "connecting" : "idle";
      return { client: ready ? client : { ...client, participantId: null, connectionStatus: review.rosterState, state: null }, publishCursor: noop, requestControl: noop, takeControl: noop, releaseControl: noop, grantControl: noop };
    }
  `,
  "/src/screens/studio/components/useSharedBrowserApproval.ts": `export const useSharedBrowserApproval = () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: () => {} });`,
  "/src/screens/studio/components/useBrowserSessionActions.ts": `export const useBrowserSessionActions = () => ({ actions: [], latestClick: null });`,
  "/src/screens/studio/components/CdpScreencastViewer.tsx": `
    // The fallback is negotiated but deliberately has no pixels yet. Merely
    // mounting a transport must not dismiss the retained RFB frame.
    export function CdpScreencastViewer() {
      const review = window.__browserSwitchReview;
      review.hooks.useEffect(() => { review.cdpMounts += 1; }, []);
      return null;
    }
  `,
  "/src/services/runtimeController/origins.ts": `export async function requestOriginAccessToken() { return { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 }; }`,
  "@novnc/novnc/lib/rfb": `export default window.__browserSwitchReview.RFB;`,
};
browserSwitchBoundaries["/src/sdk/instafy/index.ts"] = browserSwitchBoundaries["/src/sdk/instafy"]!;
