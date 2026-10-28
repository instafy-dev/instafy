/** Inert service boundaries; recovery state and all actions belong to the real modal. */
export const recoveryBoundaries: Record<string, string> = {
  "/src/sdk/instafy": `
    const review = () => window.__browserRecoveryReview;
    const token = { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 };
    const runtime = { runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", origin: { originId: "review-origin", endpoint: token.endpoint, protocols: ["http"] } };
    export const controllerClient = {
      core: { enabled: true, baseUrl: "" },
      runtimes: {
        fetchStatus: async () => {
          const state = review(); state.discoveryCount += 1;
          if (state.surface === "reconnecting") {
            if (state.disconnected) return new Promise(() => {});
            return { runtimes: [runtime] };
          }
          return { runtimes: [] };
        },
        ensure: async () => {
          const state = review(); state.ensureCount += 1;
          if (state.surface !== "runtime-limit") throw new Error(state.connectionError);
          throw Object.assign(new Error("Instafy Cloud runtime limit reached"), { code: "runtime_limit_reached", details: {
            activeCount: 1, maxActiveCount: 1,
            blockerRuntimeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            blockerProjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            blockerRuntimeLabel: "Quarterly financial reconciliation and forecasting browser",
            blockerProjectLabel: "International operations and financial planning workspace"
          } });
        },
        stop: async (options) => {
          const state = review(); state.stopCalls.push(options);
          return new Promise((resolve, reject) => { state.finishStop = (fail = false) => {
            if (fail) reject(new Error("The machine did not answer. Check your connection and try again."));
            else resolve({ statusChanged: true });
          }; });
        },
        stopIfIdle: async () => ({ statusChanged: false })
      },
      browserProfiles: { fetchStatus: async () => ({ success: true, status: { enabled: false } }) },
      browserSessions: { fetchPages: async () => ({ pages: [] }), isUnavailableError: () => false, isHostRefusedError: () => false },
      workspace: { origin: { requestAccessToken: async () => token, requestAccessTokenResult: async () => ({ ok: true, token }) } }
    };
  `,
  "/src/screens/studio/components/useSharedBrowserCollaboration.ts": `
    const participant = { id: "review-user", displayName: "You", kind: "human", role: "editor", canControl: true, joinedAt: 1, lastSeenAt: 1, pageId: null, cursor: null };
    const client = { connectionStatus: "connected", participantId: participant.id, error: null, state: { participants: [participant], controlOwner: { kind: "human", participantId: participant.id }, requests: [], controlRequests: [], controllerParticipantId: participant.id } };
    const noop = () => {};
    export const useSharedBrowserCollaboration = () => ({ client, publishCursor: noop, requestControl: noop, takeControl: noop, releaseControl: noop, grantControl: noop });
  `,
  "/src/screens/studio/components/useSharedBrowserApproval.ts": `export const useSharedBrowserApproval = () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, decide: () => {} });`,
  "/src/screens/studio/components/useBrowserSessionActions.ts": `export const useBrowserSessionActions = () => ({ actions: [], latestClick: null });`,
  "/src/services/runtimeController/origins.ts": `export async function requestOriginAccessToken() { return { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 }; }`,
  "/src/screens/studio/components/CdpScreencastViewer.tsx": `
    export function CdpScreencastViewer(props) {
      const { useEffect, useRef, createElement } = window.__browserRecoveryReview.hooks;
      const latest = useRef(props); latest.current = props;
      useEffect(() => {
        const state = window.__browserRecoveryReview;
        if (state.disconnected) return;
        latest.current.onConnected();
        const timer = setTimeout(() => {
          state.disconnected = true;
          latest.current.onDisconnected({ connected: true, reason: "WebSocket closed (1006)" });
        }, 100);
        return () => clearTimeout(timer);
      }, []);
      return createElement("div", { "data-testid": "review-browser-page", style: { width: "100%", height: "100%", background: "#f7f8fa", color: "#34363b", padding: "32px", fontFamily: "system-ui" } },
        createElement("h1", { style: { fontSize: "22px", margin: "0 0 16px" } }, "Project notes"),
        createElement("p", { style: { fontSize: "15px", maxWidth: "36em" } }, "The browser is reconnecting. This is an inert preview page; no browser or remote session is running."));
    }
  `,
};
recoveryBoundaries["/src/sdk/instafy/index.ts"] = recoveryBoundaries["/src/sdk/instafy"]!;
