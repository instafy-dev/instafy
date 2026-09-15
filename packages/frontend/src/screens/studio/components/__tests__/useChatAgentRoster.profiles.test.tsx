// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatAgentRoster } from "../useChatAgentRoster";
import { AssistantSpeakerIdentityLabel } from "../AssistantSpeakerIdentityPill";
import { OPEN_AGENT_PROFILE_EVENT, type OpenAgentProfileDetail } from "../agentProfileOpen";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { core: { enabled: true }, agents: { list: mocks.list } } }));
vi.mock("../AssistantAvatarPopover", () => ({ AssistantAvatarPopover: () => null }));
vi.mock("../ChatMessageAvatar", () => ({ ChatMessageAvatar: () => <span /> }));
const ownAgent = {
  id: "own-bot", handle: "build", displayName: "My build bot", avatarSeed: "own-photo",
  bio: "My bot bio", description: null, provider: "openai", model: null, reasoningEffort: null,
  credentialId: null, runtimeId: "own-runtime", createdAt: "", updatedAt: "",
};
const args = {
  activeConversationId: "conversation", activeProjectId: "project", currentUserId: "viewer",
  agentHandles: ["build"], assistantEnabled: false, extraAgentHandles: [], runs: {},
  currentRuntime: { label: "My machine", state: "ready" }, runtimeOptionsById: new Map(), preferredRuntimeId: null,
  onOpenAgentProfileSettings: vi.fn(), onRemoveAgentHandle: vi.fn(), setChatSendQueue: vi.fn(), showStatus: vi.fn(),
  stickyMentionedAgentByConversationRef: { current: new Map<string, string>() },
};

describe("exact bot profile identities", () => {
  let root: Root;
  let container: HTMLDivElement;
  let roster: ReturnType<typeof useChatAgentRoster>;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.list.mockReset().mockResolvedValue({ success: true, agents: [ownAgent] });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  function Harness({ userId = "viewer" }: { userId?: string }) {
    roster = useChatAgentRoster({ ...args, currentUserId: userId });
    return null;
  }
  async function render(userId = "viewer") { await act(async () => root.render(<Harness userId={userId} />)); }

  it("does not mix a teammate's bio with the same-handle own bot's identity or settings", async () => {
    await render();
    const card = roster.renderAssistantAvatar({ agent: { id: "peer-bot", handle: "build", avatarSeed: "peer-photo" } });
    expect(card.props).toMatchObject({ agentId: "peer-bot", agentAvatarSeed: "peer-photo", displayName: "@build", canEditProfile: false, pinnedRuntimeId: null });
    expect(card.props.onOpenSettings).toBeUndefined();
    expect(card.props.runtimeLabel).not.toBe("My machine");
  });

  it("only exact own IDs enable editing and handle-only links remain unidentified", async () => {
    await render();
    expect(roster.resolveAgentProfileCardProps("build", { id: "own-bot", handle: "build", avatarSeed: "older-photo" }))
      .toMatchObject({ agentId: "own-bot", canEditProfile: true, displayName: "My build bot", agentAvatarSeed: "own-photo" });
    expect(roster.resolveAgentProfileCardProps("build")).toMatchObject({ agentId: null, canEditProfile: false, displayName: "@build" });
  });

  it("retains the exact ID from metadata when the display identity lacks one", async () => {
    await render();
    const card = roster.renderAssistantAvatar({ agent: { id: "peer-bot", handle: "build" } }, { handle: "build", avatarSeed: "peer-photo" });
    expect(card.props).toMatchObject({ agentId: "peer-bot", agentAvatarSeed: "peer-photo", canEditProfile: false });
  });

  it("discards old-account roster responses instead of granting edit ownership", async () => {
    await render();
    let resolveOld!: (value: { success: true; agents: typeof ownAgent[] }) => void;
    mocks.list.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = roster.refreshAvailableAgents(); });
    mocks.list.mockResolvedValueOnce({ success: true, agents: [] });
    await render("other-user");
    await act(async () => { resolveOld({ success: true, agents: [ownAgent] }); await pending; });
    expect(roster.availableAgents).toEqual([]);
    expect(roster.resolveAgentProfileCardProps("build", { id: "own-bot", handle: "build", avatarSeed: "own-photo" }).canEditProfile).toBe(false);
  });

  it("forwards the observed identity when the mobile speaker avatar opens a profile", async () => {
    const seen: OpenAgentProfileDetail[] = [];
    const handler = (event: Event) => seen.push((event as CustomEvent<OpenAgentProfileDetail>).detail);
    window.addEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
    try {
      await act(async () => root.render(<AssistantSpeakerIdentityLabel handle="build" metadata={{ agent: { id: "peer-bot", handle: "build", avatarSeed: "peer-photo" } }} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-speaker-agent-profile"]')!.click());
      expect(seen).toEqual([{ handle: "build", agentId: "peer-bot", avatarSeed: "peer-photo" }]);
    } finally {
      window.removeEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
    }
  });
});
