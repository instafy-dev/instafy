// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProfileModal } from "../AgentProfileModal";
import { AgentProfileCardContent } from "../AssistantAvatarPopover";

const publicProfile = { id: "bot", handle: "helper", displayName: "Updated Helper", avatarSeed: "helper", bio: null };

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "viewer" } }) }));
vi.mock("../../../../services/runtimeController/agents", () => ({ getPublicAgentProfile: mocks.read }));
vi.mock("../../../../conversations/ConversationsProvider", () => ({ useConversations: () => ({ conversations: [] }) }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runs: {} }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ openConversationTab: vi.fn(), openPanelTab: vi.fn(), requestUrlPush: vi.fn() }) }));
vi.mock("../ChatMessageAvatar", () => ({ ChatMessageAvatar: () => <span>Avatar</span> }));

function Editor() {
  const [bio, setBio] = useState("");
  const [description, setDescription] = useState("Answer concisely.");
  return <AgentProfileModal isOpen mode="edit" title="Edit bot" handle="helper" displayName="Helper"
    avatarImageUrl="" onHandleChange={() => {}} onDisplayNameChange={() => {}} onAvatarImageUrlChange={() => {}}
    bio={bio} onBioChange={setBio} description={description} onDescriptionChange={setDescription}
    onClose={() => {}} onSave={() => mocks.save({ bio, description })} />;
}

describe("agent public About", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.read.mockReset(); mocks.save.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const card = (agentId = "bot") => <AgentProfileCardContent agentId={agentId} projectId="space" agentHandle="helper"
    displayName="Helper" agentAvatarSeed="helper" pinnedRuntimeId={null} resourcesSummary={null} runtimeLabel="Shared" runtimeState="ready" />;

  it("keeps public About separate from style guidance and validates Unicode length", async () => {
    await act(async () => root.render(<Editor />));
    const bio = document.querySelector<HTMLTextAreaElement>("#agent-profile-bio")!;
    const set = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(bio, value);
      bio.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await set("I help with builds.");
    await act(async () => (document.querySelector('[data-testid="agent-profile-save"]') as HTMLButtonElement).click());
    expect(mocks.save).toHaveBeenCalledWith({ bio: "I help with builds.", description: "Answer concisely." });
    await set("🛠".repeat(500));
    expect((document.querySelector('[data-testid="agent-profile-save"]') as HTMLButtonElement).disabled).toBe(false);
    await set("🛠".repeat(501));
    expect((document.querySelector('[data-testid="agent-profile-save"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains connection-free creation and requires its handle before saving", async () => {
    const render = (handle: string) => <AgentProfileModal isOpen mode="create" title="New agent" handle={handle}
      handleRequired displayName="Reviewer" avatarImageUrl="" onHandleChange={() => {}}
      onDisplayNameChange={() => {}} onAvatarImageUrlChange={() => {}} description=""
      onDescriptionChange={() => {}} onClose={() => {}} onSave={mocks.save}
      connectionHint="No AI connection yet. You can save this profile now and connect AI before chatting." />;
    await act(async () => root.render(render("")));
    expect(document.querySelector<HTMLInputElement>('#agent-profile-handle')?.required).toBe(true);
    expect(document.querySelector('[data-testid="agent-profile-connection-hint"]')?.textContent).toContain("connect AI before chatting");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-save"]')?.disabled).toBe(true);
    await act(async () => root.render(render("@reviewer")));
    expect(document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-save"]')?.disabled).toBe(false);
  });

  it("reads the exact project and agent and displays only plain-text public bio", async () => {
    mocks.read.mockResolvedValue({ success: true, value: { ...publicProfile, bio: "<script>alert(1)</script>\nBuild specialist", description: "PRIVATE STYLE" } });
    await act(async () => root.render(card()));
    expect(mocks.read).toHaveBeenCalledWith("space", "bot", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector('[data-testid="agent-profile-about"]')?.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Updated Helper");
    expect(container.textContent).not.toContain("Settings");
    expect(container.textContent).not.toContain("PRIVATE STYLE");
  });

  it("does not reuse an old bio when a request fails or the agent changes", async () => {
    mocks.read.mockResolvedValueOnce({ success: true, value: { ...publicProfile, bio: "Old bio" } });
    await act(async () => root.render(card()));
    mocks.read.mockResolvedValueOnce({ success: false, error: "Forbidden" });
    await act(async () => root.render(card("new-bot")));
    expect(container.textContent).not.toContain("Old bio");
    expect(container.textContent).toContain("About is unavailable.");
    mocks.read.mockResolvedValueOnce({ success: true, value: { ...publicProfile, id: "new-bot", displayName: null, bio: null } });
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry profile")!.click());
    expect(container.textContent).not.toContain("About is unavailable.");
    expect(container.querySelector('[data-testid="agent-profile-about"]')).toBeNull();
    expect(container.textContent).not.toContain("Updated Helper");
  });
});
