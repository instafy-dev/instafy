import { browserShareClient as viewerClient } from "../style-followups-controls/browserData";
import type { BrowserShareAudience } from "../../../src/services/runtimeController/browserShares";
import type { LocalTabControlState } from "../../../src/services/runtimeController/localTabControl";

/** Service boundaries only. Actual sharing, viewer, dialog, controls and parsers render unchanged. */
const person = { userId: "review-person", fullName: "Alex with a longer display name", email: "alex@example.test", active: true, removed: false };
const state = new URLSearchParams(location.search).get("state");
export async function browserShareClient() {
  return { ...(await viewerClient()), people: async () => ({ people: [person], hasMore: false }), viewers: async () => [person], removeViewer: async () => {}, stop: async () => {} };
}
export async function publishLocalBrowserTab(projectId: string, _owner: string, signal: AbortSignal, ended: () => void,
  audience: BrowserShareAudience, onControl: (state: LocalTabControlState) => void) {
  const granted: LocalTabControlState = { type: "controlState", available: true, connectionId: "review-owner",
    grant: { id: "review-grant", connectionId: "review-viewer", userId: person.userId }, requested: false, requests: [] };
  const timer = window.setTimeout(() => { if (!signal.aborted) onControl(granted); }, 60);
  const requestTimer = window.setTimeout(() => { if (!signal.aborted) window.dispatchEvent(new CustomEvent("consistency-review-action", { detail: "native-takeback" })); }, 180);
  signal.addEventListener("abort", () => { clearTimeout(timer); clearTimeout(requestTimer); ended(); }, { once: true });
  return { id: "review-publication", projectId, ownerUserId: "review-owner", audience: audience.audience, mode: "view" as const,
    control: {
      grant: async () => {}, deny: () => {},
      revoke: async () => {
        window.dispatchEvent(new CustomEvent("consistency-review-action", { detail: "take-back" }));
        if (state === "busy") await new Promise<void>(() => {});
        if (state === "error") throw new Error("Review failure");
        onControl({ ...granted, grant: null });
      },
    },
  };
}
