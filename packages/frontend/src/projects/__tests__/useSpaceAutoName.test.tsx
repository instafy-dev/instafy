/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../../conversations/conversationState";

const mocks = vi.hoisted(() => ({
  project: {
    activeProjectId: "",
    activeProjectName: "Untitled space",
    canWriteProject: true,
    projectCapabilitiesResolved: true,
  },
  conversations: { projectKey: "", remoteConversationHistoryResolved: true, conversations: [] as ConversationState[] },
  setProjectName: vi.fn(),
  getSummaryResult: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("../useProject", () => ({ useProject: () => mocks.project }));
vi.mock("../ProjectStateProvider", () => ({ useProjectState: () => ({ setProjectName: mocks.setProjectName }) }));
vi.mock("../../conversations/ConversationsProvider", () => ({ useConversations: () => mocks.conversations }));
vi.mock("../../sdk/instafy", () => ({
  controllerClient: { projects: { getSummaryResult: mocks.getSummaryResult, rename: mocks.rename } },
}));
vi.mock("../spaceAutoName", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spaceAutoName")>();
  return { ...actual, resolveSpaceAutoName: vi.fn(actual.resolveSpaceAutoName) };
});

import { resolveSpaceAutoName } from "../spaceAutoName";
import { useSpaceAutoName } from "../useSpaceAutoName";

const FREEFINANCE_IMPORT =
  "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --name freefinance --start";
let nextSpace = 0;

function chat(title: string, opening: string, createdAt = 1): ConversationState {
  return {
    localId: `conversation-${createdAt}`,
    title,
    visibility: "public",
    lifecycleStatus: "active",
    parentConversationId: null,
    threadKind: null,
    createdAt,
    messages: [{ id: "user-1", role: "user", authorId: "user-a", content: opening, timestamp: 1, files: null, messageType: "user", metadata: null }],
  } as unknown as ConversationState;
}

function Harness() {
  useSpaceAutoName();
  return null;
}

describe("useSpaceAutoName", () => {
  let container: HTMLDivElement;
  let root: Root;
  let spaceId: string;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Attempts are remembered per space for the page's life, as in the app.
    nextSpace += 1;
    spaceId = `space-${nextSpace}`;
    mocks.project = {
      activeProjectId: spaceId,
      activeProjectName: "Untitled space",
      canWriteProject: true,
      projectCapabilitiesResolved: true,
    };
    mocks.conversations = {
      projectKey: spaceId,
      remoteConversationHistoryResolved: true,
      conversations: [chat("Connect FreeFinance", FREEFINANCE_IMPORT)],
    };
    vi.mocked(resolveSpaceAutoName).mockClear();
    mocks.setProjectName.mockReset();
    mocks.getSummaryResult.mockReset().mockResolvedValue({ summary: { projectId: spaceId, projectName: null } });
    mocks.rename.mockReset().mockImplementation(async ({ projectId, projectName }) => ({ projectId, projectName }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderAndSettle() {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("names an untitled space after the connector its first chat set up", async () => {
    await renderAndSettle();
    expect(mocks.rename).toHaveBeenCalledWith({ projectId: spaceId, projectName: "FreeFinance" });
    expect(mocks.setProjectName).toHaveBeenCalledWith(spaceId, "FreeFinance");
  });

  it("leaves the space untitled when its first chat did not open with an import", async () => {
    mocks.conversations.conversations = [chat("File my VAT return for March", "help me file my VAT return for March")];
    await renderAndSettle();
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("treats an old stored placeholder as untitled", async () => {
    mocks.project.activeProjectName = "Untitled Space";
    mocks.getSummaryResult.mockResolvedValue({ summary: { projectId: spaceId, projectName: "Untitled Space" } });
    await renderAndSettle();
    expect(mocks.rename).toHaveBeenCalledWith({ projectId: spaceId, projectName: "FreeFinance" });
  });

  it("never replaces a name someone chose, nor reads the chats of a named space", async () => {
    mocks.project.activeProjectName = "Books 2026";
    await renderAndSettle();
    expect(resolveSpaceAutoName).not.toHaveBeenCalled();
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("waits for the chat list, then names the space after its first chat only", async () => {
    mocks.conversations = {
      projectKey: spaceId,
      remoteConversationHistoryResolved: false,
      conversations: [chat("Conversation 1", "hi", 1), chat("Connect FreeFinance", FREEFINANCE_IMPORT, 5)],
    };
    await renderAndSettle();
    expect(resolveSpaceAutoName).not.toHaveBeenCalled();
    mocks.conversations = { ...mocks.conversations, remoteConversationHistoryResolved: true };
    await renderAndSettle();
    expect(resolveSpaceAutoName).toHaveBeenCalled();
    // The first chat still has its numbered title, so a newer one does not stand in.
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("keeps a rename made elsewhere that this tab has not seen yet", async () => {
    mocks.getSummaryResult.mockResolvedValue({ summary: { projectId: spaceId, projectName: "Books 2026" } });
    await renderAndSettle();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.setProjectName).toHaveBeenCalledWith(spaceId, "Books 2026");
  });

  it("does nothing for someone who cannot edit the space, or before access is known", async () => {
    mocks.project.canWriteProject = false;
    await renderAndSettle();
    mocks.project = { ...mocks.project, canWriteProject: true, projectCapabilitiesResolved: false };
    await renderAndSettle();
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("waits for a real title and ignores the previous space's chats during a switch", async () => {
    mocks.conversations.conversations = [chat("Conversation 1", "hi")];
    await renderAndSettle();
    mocks.conversations = {
      projectKey: "previous-space",
      remoteConversationHistoryResolved: true,
      conversations: [chat("Connect FreeFinance", FREEFINANCE_IMPORT)],
    };
    await renderAndSettle();
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
  });

  it("tries once per space and keeps quiet when the rename fails", async () => {
    mocks.rename.mockRejectedValue(new Error("update project failed (500)"));
    await renderAndSettle();
    mocks.conversations = {
      projectKey: spaceId,
      remoteConversationHistoryResolved: true,
      conversations: [chat("Set up Bookkeeping", "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping --start")],
    };
    await renderAndSettle();
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(mocks.setProjectName).not.toHaveBeenCalled();
  });
});
