/**
 * Opens the agent profile card from surfaces that have no trigger machinery
 * of their own (inline mention chips, the narrow-layout speaker label): they
 * dispatch this event with a handle, and ChatPanel — which owns agent
 * resolution — presents the card as a centered modal.
 */

export const OPEN_AGENT_PROFILE_EVENT = "instafy:open-agent-profile";

export interface OpenAgentProfileDetail {
  handle: string;
}

export function requestAgentProfile(handle: string): void {
  if (typeof window === "undefined") return;
  const trimmed = handle.trim();
  const normalized = (trimmed.startsWith("@") ? trimmed.slice(1) : trimmed)
    .trim()
    .toLowerCase();
  if (!normalized) return;
  window.dispatchEvent(
    new CustomEvent<OpenAgentProfileDetail>(OPEN_AGENT_PROFILE_EVENT, {
      detail: { handle: normalized },
    }),
  );
}
