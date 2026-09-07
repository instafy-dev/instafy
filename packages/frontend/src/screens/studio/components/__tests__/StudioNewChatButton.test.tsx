// @vitest-environment jsdom

import { act, Children, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioNewChatButton } from "../StudioNewChatButton";

const mocks = vi.hoisted(() => ({
  publicChat: vi.fn(),
  privateChat: vi.fn(),
  listOrgMembers: vi.fn(),
  listProjectMembers: vi.fn(),
  allowed: true,
}));

vi.mock("../../workspaceControls", () => ({
  useWorkspaceControls: () => ({
    onStartNewConversation: mocks.publicChat,
    onStartPrivateConversation: mocks.privateChat,
    showChatActions: mocks.allowed,
  }),
}));
vi.mock("../../../../projects/useProjects", () => ({
  useProjects: () => ({ activeProjectId: "project-1", projectList: [{ id: "project-1", orgId: "team-1" }] }),
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "self" } }) }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    organizations: { listMembers: mocks.listOrgMembers },
    projects: { listMembers: mocks.listProjectMembers },
  },
}));
vi.mock("react-aria-components", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...original,
    DialogTrigger: ({ children, isOpen, onOpenChange }: {
      children: ReactNode;
      isOpen: boolean;
      onOpenChange: (open: boolean) => void;
    }) => {
      const [trigger, content] = Children.toArray(children);
      return <>{cloneElement(trigger as ReactElement<{ onPress: () => void }>, { onPress: () => onOpenChange(!isOpen) })}{isOpen ? content : null}</>;
    },
  };
});
vi.mock("../../../../components/aria/StudioPopover", () => ({
  StudioDialogPopover: ({ children }: { children: ReactNode }) => <div data-testid="new-chat-menu">{children}</div>,
}));
vi.mock("../../../../components/aria/StudioModal", () => ({
  StudioDialogModal: ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) => isOpen ? <div data-testid="private-chat-picker">{children}</div> : null,
}));
vi.mock("../../../../components/aria/StudioDialogLayout", () => ({
  StudioDialogHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

describe("StudioNewChatButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.allowed = true;
    mocks.listOrgMembers.mockResolvedValue([
      { userId: "self", fullName: "Me" },
      { userId: "ada", fullName: "Ada", email: "ada@example.test" },
    ]);
    mocks.listProjectMembers.mockResolvedValue([
      { userId: "ada", fullName: "Ada", email: "ada@example.test" },
      { userId: "grace", fullName: "Grace", email: "grace@example.test" },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function click(testId: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  it("keeps public/private chat choices on the sidebar trigger and closes after starting", async () => {
    const onStarted = vi.fn();
    await act(async () => root.render(<StudioNewChatButton testId="sidebar-new-conversation" onStarted={onStarted} />));
    expect(mocks.listProjectMembers).not.toHaveBeenCalled();
    await click("sidebar-new-conversation");
    expect(container.textContent).toContain("Public chat");
    expect(container.textContent).toContain("Private chat");
    await click("chat-new-chat-public");
    expect(mocks.publicChat).toHaveBeenCalledTimes(1);
    expect(mocks.privateChat).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="new-chat-menu"]')).toBeNull();
  });

  it("starts a private conversation only after selecting one eligible teammate", async () => {
    const onStarted = vi.fn();
    await act(async () => root.render(<StudioNewChatButton onStarted={onStarted} />));
    await click("topbar-new-conversation");
    await click("chat-new-chat-private");
    expect(mocks.privateChat).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat-private-chat-target-self"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="chat-private-chat-target-ada"]')).toHaveLength(1);
    expect(mocks.listOrgMembers).toHaveBeenCalledWith("team-1");
    expect(mocks.listProjectMembers).toHaveBeenCalledWith("project-1");
    await click("chat-private-chat-target-ada");
    expect(mocks.privateChat).toHaveBeenCalledWith({ userId: "ada", displayName: "Ada" });
    expect(mocks.publicChat).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="private-chat-picker"]')).toBeNull();
  });

  it("does not offer chat creation when access is blocked", async () => {
    mocks.allowed = false;
    await act(async () => root.render(<StudioNewChatButton />));
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.listProjectMembers).not.toHaveBeenCalled();
  });
});
