import { browserSwitchBoundaries } from "../browser-transport-switch/boundaries";

/** Only controller/collaboration data and the Shared transport are controlled.
 * The actual Desktop preload, IPC and Personal WebContentsView are untouched.
 */
export const electronSwitchBoundaries = {
  ...browserSwitchBoundaries,
  "@novnc/novnc/lib/rfb": `export default window.__nativeBrowserSwitchReview.RFB;`,
  "/src/screens/studio/components/useSharedBrowserCollaboration.ts": `
    const participant = { id: "review-user", displayName: "You", kind: "human", role: "editor", canControl: true, joinedAt: 1, lastSeenAt: 1, pageId: "review-page", cursor: null };
    const client = { connectionStatus: "connected", participantId: participant.id, error: null, state: { participants: [participant], controlOwner: { kind: "human", participantId: participant.id }, requests: [], controlRequests: [], controllerParticipantId: participant.id } };
    const noop = () => {};
    export function useSharedBrowserCollaboration({ active }) {
      return { client: active ? client : { ...client, participantId: null, connectionStatus: "idle", state: null }, publishCursor: noop, requestControl: noop, takeControl: noop, releaseControl: noop, grantControl: noop };
    }
  `,
};
