import type { AssistantAgentIdentity } from "./chatAssistantIdentity";

/**
 * Opens the agent profile card from surfaces that have no trigger machinery
 * of their own (inline mention chips, the narrow-layout speaker label): they
 * dispatch this event with the observed identity, and ChatPanel — which owns agent
 * resolution — presents the card as a centered modal.
 */

export const OPEN_AGENT_PROFILE_EVENT = "instafy:open-agent-profile";

export interface OpenAgentProfileDetail {
  handle: string;
  agentId?: string;
  avatarSeed?: string;
}

/**
 * Who the opened card is for. A speaker label hands over its row's identity.
 * A mention chip names the AI by its handle alone: the viewer's own saved
 * agent with that handle, drawn as the gutter draws it, else null, an AI known
 * only from text, which wears the hollow face (docs/Brand.md, "Octo's
 * hatchlings").
 */
export function resolveOpenedAgentIdentity(
  detail: OpenAgentProfileDetail,
  viewerAgentByHandle: ReadonlyMap<string, { id: string; avatarSeed: string }>,
): AssistantAgentIdentity | null {
  const { handle, agentId, avatarSeed } = detail;
  if (agentId || avatarSeed) {
    return { handle, avatarSeed: avatarSeed || agentId || handle, ...(agentId ? { id: agentId } : {}) };
  }
  const saved = viewerAgentByHandle.get(handle);
  return saved ? { handle, avatarSeed: saved.avatarSeed, id: saved.id } : null;
}

export function requestAgentProfile(handle: string, identity?: { id?: string; avatarSeed?: string } | null): void {
  if (typeof window === "undefined") return;
  const trimmed = handle.trim();
  const normalized = (trimmed.startsWith("@") ? trimmed.slice(1) : trimmed)
    .trim()
    .toLowerCase();
  if (!normalized) return;
  const agentId = identity?.id?.trim();
  const avatarSeed = identity?.avatarSeed?.trim();
  window.dispatchEvent(
    new CustomEvent<OpenAgentProfileDetail>(OPEN_AGENT_PROFILE_EVENT, {
      detail: { handle: normalized, ...(agentId ? { agentId } : {}), ...(avatarSeed ? { avatarSeed } : {}) },
    }),
  );
}
