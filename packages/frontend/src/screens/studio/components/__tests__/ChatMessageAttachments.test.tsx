// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";

const mocks = vi.hoisted(() => ({
  getWorkspaceFileRawUrl: vi.fn(),
  downloadChatAttachment: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../sdk/instafy")>();
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      workspace: {
        ...actual.controllerClient.workspace,
        files: { ...actual.controllerClient.workspace.files, getRawUrl: mocks.getWorkspaceFileRawUrl },
      },
    },
  };
});
vi.mock("../../../../lib/chatAttachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/chatAttachments")>();
  return { ...actual, downloadChatAttachment: mocks.downloadChatAttachment };
});
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => {
    throw new Error("Message bodies must not subscribe to composer draft state.");
  },
}));
vi.mock("../../../../conversations/ConversationMessageMetadata", () => ({
  useConversationMessageMetadata: () => ({ resolveConversationLocalId: () => null, extraAgentHandles: [] }),
}));
vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => {
    throw new Error("Message bodies must not mount conversation history or dispatch effects.");
  },
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openConversationTab: vi.fn(), openPanelTab: vi.fn(), requestUrlPush: vi.fn() }),
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));

import { extractChatAttachments, extractImageAttachments, UserMessageBubble } from "../ChatMessageEntries";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const CONVERSATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STORAGE_PATH = `${PROJECT}/${CONVERSATION}/0f0f0f0f-1111-4222-8333-444444444444.png`;
const TEXT_PATH = `${PROJECT}/${CONVERSATION}/0f0f0f0f-1111-4222-8333-555555555555.txt`;

function messageWith(attachments: unknown[]): ChatMessage {
  return {
    id: "user-message",
    role: "user",
    content: "Look at this",
    timestamp: 1,
    metadata: { attachments },
  };
}

describe("chat message attachments", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.getWorkspaceFileRawUrl.mockReset();
    mocks.downloadChatAttachment.mockReset();
    mocks.revokeObjectURL.mockReset();
    mocks.createObjectURL.mockReset().mockReturnValue("blob:chat-attachment-1");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = mocks.createObjectURL;
      static revokeObjectURL = mocks.revokeObjectURL;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderBubble(message: ChatMessage) {
    await act(async () => {
      root.render(<UserMessageBubble message={message} projectId={PROJECT} runtimeId="runtime-1" />);
    });
  }

  it("reads the new metadata shape and keeps legacy workspace images", () => {
    const message = messageWith([
      { kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png", mimeType: "image/png", sizeBytes: 12 },
      { kind: "file", storagePath: TEXT_PATH, fileName: "App.tsx.base.txt", mimeType: "text/plain", sizeBytes: 4 },
      { kind: "image", workspacePath: "chat-upload-1-abc-photo.png", fileName: "photo.png" },
      // Not a name of the bucket's shape: never downloaded.
      { kind: "image", storagePath: `${PROJECT}/../secret.png` },
      { kind: "file", storagePath: "notes.txt" },
      { kind: "video", storagePath: STORAGE_PATH },
    ]);
    expect(extractChatAttachments(message)).toEqual([
      {
        kind: "image",
        storagePath: STORAGE_PATH,
        workspacePath: null,
        previewUrl: null,
        fileName: "shot.png",
        mimeType: "image/png",
        sizeBytes: 12,
      },
      {
        kind: "file",
        storagePath: TEXT_PATH,
        fileName: "App.tsx.base.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      },
      {
        kind: "image",
        storagePath: null,
        workspacePath: "chat-upload-1-abc-photo.png",
        previewUrl: null,
        fileName: "photo.png",
        mimeType: null,
        sizeBytes: null,
      },
    ]);
    expect(extractImageAttachments(message)).toHaveLength(2);
  });

  it("downloads a Storage image with the session and revokes its object URL on unmount", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob });
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));

    expect(mocks.downloadChatAttachment).toHaveBeenCalledWith(STORAGE_PATH);
    expect(mocks.createObjectURL).toHaveBeenCalledWith(blob);
    const image = container.querySelector<HTMLImageElement>('[data-testid="chat-image-attachment-thumbnail"] img');
    expect(image?.getAttribute("src")).toBe("blob:chat-attachment-1");
    expect(image?.alt).toBe("shot.png");
    // Never the workspace /raw path for a Storage attachment.
    expect(mocks.getWorkspaceFileRawUrl).not.toHaveBeenCalled();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(mocks.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:chat-attachment-1");
    root = createRoot(container);
  });

  it("shows a plain placeholder when Storage refuses the read", async () => {
    mocks.downloadChatAttachment.mockResolvedValue({ ok: false });
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));

    const placeholder = container.querySelector('[data-testid="chat-image-attachment-unavailable"]');
    expect(placeholder?.textContent).toBe("Image unavailable");
    expect(placeholder?.getAttribute("aria-label")).toBe("shot.png is unavailable");
    expect(container.querySelector('[data-testid="chat-image-attachment-thumbnail"]')).toBeNull();
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });

  it("shows a loading tile until the download settles, and nothing leaks after an early unmount", async () => {
    let settle!: (value: { ok: true; blob: Blob }) => void;
    mocks.downloadChatAttachment.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH }]));
    expect(container.querySelector('[data-testid="chat-image-attachment-placeholder"]')).not.toBeNull();

    await act(async () => root.unmount());
    await act(async () => settle({ ok: true, blob: new Blob(["png"]) }));
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("keeps rendering legacy workspace images through the raw file route", async () => {
    mocks.getWorkspaceFileRawUrl.mockResolvedValue("https://controller.example/raw/photo.png");
    await renderBubble(messageWith([{ kind: "image", workspacePath: "chat-upload-1-abc-photo.png", fileName: "photo.png" }]));

    expect(mocks.getWorkspaceFileRawUrl).toHaveBeenCalledWith({
      projectId: PROJECT,
      path: "chat-upload-1-abc-photo.png",
      runtimeId: "runtime-1",
    });
    expect(mocks.downloadChatAttachment).not.toHaveBeenCalled();
    const image = container.querySelector<HTMLImageElement>('[data-testid="chat-image-attachment-thumbnail"] img');
    expect(image?.getAttribute("src")).toBe("https://controller.example/raw/photo.png");
  });

  it("names attached text files without downloading them", async () => {
    await renderBubble(messageWith([{ kind: "file", storagePath: TEXT_PATH, fileName: "App.tsx.base.txt" }]));
    expect(container.querySelector('[data-testid="chat-file-attachment"]')?.textContent).toBe("App.tsx.base.txt");
    expect(mocks.downloadChatAttachment).not.toHaveBeenCalled();
  });
});
