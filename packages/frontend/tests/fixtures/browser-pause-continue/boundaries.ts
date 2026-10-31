/**
 * Inert service boundaries for the sign-in pause review. The modal, its
 * toolbar, the pause's row and every control are production components; only
 * the controller SDK, the browser's collaboration socket, its approval poll,
 * its action log and the screencast are stand-ins, served in place of their
 * modules. `window.__browserPauseReview` (main.tsx) holds what they answer.
 */
export const browserPauseBoundaries: Record<string, string> = {
  "/src/sdk/instafy/index.ts": `
    const token = { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 };
    const runtime = { runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", origin: { originId: "review-origin", endpoint: token.endpoint, protocols: ["http"] } };
    export const controllerClient = {
      core: { enabled: true, baseUrl: "" },
      runtimes: {
        fetchStatus: async () => ({ runtimes: [runtime] }),
        ensure: async () => new Promise(() => {}),
        stop: async () => ({ statusChanged: false }),
        stopIfIdle: async () => ({ statusChanged: false })
      },
      browserProfiles: { fetchStatus: async () => ({ success: true, status: { enabled: false } }) },
      browserSessions: { fetchPages: async () => ({ pages: [] }), isUnavailableError: () => false, isHostRefusedError: () => false },
      workspace: { origin: { requestAccessToken: async () => token, requestAccessTokenResult: async () => ({ ok: true, token }) } }
    };
  `,
  "/src/services/runtimeController/origins.ts": `export async function requestOriginAccessToken() { return { token: "inert-review-token", endpoint: "https://browser.example.test", expiresIn: 300 }; }`,
  // The browser's collaboration socket: one person, who holds the browser or
  // finds it free. Take control gives it to them, as the browser does when
  // nobody holds it.
  "/src/screens/studio/components/useSharedBrowserCollaboration.ts": `
    export function useSharedBrowserCollaboration() {
      const review = window.__browserPauseReview;
      const { useState } = review.hooks;
      const [owner, setOwner] = useState(review.owner);
      const person = { id: review.participantId, displayName: "You", color: "#0ea5e9", pageId: null, cursor: null, canControl: true };
      const client = { connectionStatus: "connected", participantId: person.id, error: null,
        state: { revision: 1, participants: [person], controlOwner: owner, requests: [] } };
      return {
        client,
        publishCursor: () => {},
        requestControl: () => true,
        releaseControl: () => true,
        grantControl: () => true,
        takeControl: () => {
          review.takeControlCalls += 1;
          setTimeout(() => setOwner({ kind: "human", participantId: person.id }), 50);
          return true;
        },
      };
    }
  `,
  "/src/screens/studio/components/useSharedBrowserApproval.ts": `export const useSharedBrowserApproval = () => ({ pending: null, submitting: false, error: null, routineApprovedRunId: null, lastDecision: null, decide: () => {} });`,
  "/src/screens/studio/components/useBrowserSessionActions.ts": `
    export function useBrowserSessionActions() {
      const actions = window.__browserPauseReview.actions;
      return { actions, latestClick: null, refresh: () => {}, logSeq: actions.length };
    }
  `,
  // The page on screen: a sign-in page, drawn by the review, never a live one.
  "/src/screens/studio/components/CdpScreencastViewer.tsx": `
    export function CdpScreencastViewer(props) {
      const { useEffect, useRef, createElement } = window.__browserPauseReview.hooks;
      const latest = useRef(props); latest.current = props;
      useEffect(() => { latest.current.onConnected(); }, []);
      const field = (label) => createElement("label", { style: { display: "block", margin: "12px 0" } }, label,
        createElement("div", { style: { height: "32px", marginTop: "4px", border: "2px solid #f59e0b", borderRadius: "6px", background: "#fff" } }));
      return createElement("div", { "data-testid": "review-browser-page", style: { width: "100%", height: "100%", background: "#f6f8fa", color: "#1f2328", padding: "32px", fontFamily: "system-ui" } },
        createElement("h1", { style: { fontSize: "22px", margin: "0 0 16px" } }, "Sign in to Code Example"),
        field("Username or email address"), field("Password"));
    }
  `,
};
