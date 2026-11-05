// @vitest-environment jsdom

import { act } from "react";
import { Blob as NodeBlob } from "node:buffer";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";

const mocks = vi.hoisted(() => ({
  getWorkspaceFileRawUrl: vi.fn(),
  downloadChatAttachment: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  authListeners: new Set<(event: string, session: { user: { id: string } } | null) => void>(),
}));

vi.mock("../../../../lib/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/supabaseClient")>();
  return {
    ...actual,
    hasSupabaseConfig: true,
    supabase: {
      ...actual.supabase,
      auth: {
        ...actual.supabase.auth,
        onAuthStateChange: (listener: (event: string, session: { user: { id: string } } | null) => void) => {
          mocks.authListeners.add(listener);
          listener("INITIAL_SESSION", { user: { id: "reader-one" } });
          return { data: { subscription: { unsubscribe: () => mocks.authListeners.delete(listener) } } };
        },
      },
    },
  };
});

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
import { clearChatAttachmentPreviews, seedChatAttachmentPreview } from "../../../../lib/chatAttachmentPreviews";
import { TEXT_ATTACHMENT_PAGE_BYTES } from "../textAttachmentPage";

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
    clearChatAttachmentPreviews();
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

  it("opens the image from its accessible thumbnail", async () => {
    const onOpenImage = vi.fn();
    const imageUrl = "data:image/png;base64,cG5n";
    await act(async () => {
      root.render(
        <UserMessageBubble
          message={messageWith([{ kind: "image", previewUrl: imageUrl, fileName: "shot.png" }])}
          projectId={PROJECT}
          onOpenImage={onOpenImage}
        />,
      );
    });

    const thumbnail = container.querySelector<HTMLButtonElement>('[data-testid="chat-image-attachment-thumbnail"]');
    expect(thumbnail?.tagName).toBe("BUTTON");
    expect(thumbnail?.getAttribute("aria-label")).toBe("Open shot.png");

    await act(async () => thumbnail?.click());
    expect(onOpenImage).toHaveBeenCalledExactlyOnceWith(imageUrl, "shot.png");
  });

  it("shows a plain placeholder when Storage refuses the read", async () => {
    mocks.downloadChatAttachment.mockResolvedValue({ ok: false, reason: "refused" });
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));

    const placeholder = container.querySelector('[data-testid="chat-image-attachment-unavailable"]');
    expect(placeholder?.textContent).toBe("Image unavailable");
    expect(placeholder?.getAttribute("aria-label")).toBe("shot.png is unavailable");
    expect(container.querySelector('[data-testid="chat-image-attachment-thumbnail"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-image-attachment-retry"]')).toBeNull();
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });

  it("offers to try again when Storage could not be reached, and shows the image once it loads", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    mocks.downloadChatAttachment
      .mockResolvedValueOnce({ ok: false, reason: "transient" })
      .mockResolvedValueOnce({ ok: true, blob });
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="chat-image-attachment-retry"]');
    expect(retry?.tagName).toBe("BUTTON");
    expect(retry?.getAttribute("aria-label")).toBe("Couldn't load shot.png. Try again");
    expect(container.querySelector('[data-testid="chat-image-attachment-unavailable"]')).toBeNull();

    await act(async () => retry?.click());
    expect(mocks.downloadChatAttachment).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLImageElement>('[data-testid="chat-image-attachment-thumbnail"] img')?.getAttribute("src"))
      .toBe("blob:chat-attachment-1");
  });

  it("downloads an image once for every bubble showing it, and not again when it comes back", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    let settle!: (value: { ok: true; blob: Blob }) => void;
    mocks.downloadChatAttachment.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    let objectUrls = 0;
    mocks.createObjectURL.mockImplementation(() => `blob:view-${++objectUrls}`);
    const attachment = { kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" };
    await act(async () => {
      root.render(
        <>
          <UserMessageBubble message={messageWith([attachment])} projectId={PROJECT} />
          <UserMessageBubble message={{ ...messageWith([attachment]), id: "copy" }} projectId={PROJECT} />
        </>,
      );
    });
    await act(async () => settle({ ok: true, blob }));
    expect(mocks.downloadChatAttachment).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll<HTMLImageElement>('[data-testid="chat-image-attachment-thumbnail"] img')]
      .map((image) => image.getAttribute("src"))).toEqual(["blob:view-1", "blob:view-2"]);

    // Each bubble revokes its own URL when it goes away.
    await act(async () => root.unmount());
    expect(mocks.revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(["blob:view-1", "blob:view-2"]);

    // Scrolled back into view, or the chat opened again: no new download.
    root = createRoot(container);
    await renderBubble(messageWith([attachment]));
    expect(mocks.downloadChatAttachment).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLImageElement>('[data-testid="chat-image-attachment-thumbnail"] img')?.getAttribute("src"))
      .toBe("blob:view-3");
  });

  it("shows the sender's own image from the local copy kept after the upload", async () => {
    const local = new File(["png"], "shot.png", { type: "image/png" });
    seedChatAttachmentPreview(STORAGE_PATH, local);
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));
    expect(mocks.downloadChatAttachment).not.toHaveBeenCalled();
    expect(mocks.createObjectURL).toHaveBeenCalledWith(local);
  });

  it("waits to download an image until it is near the screen", async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      private entry: { callback: IntersectionObserverCallback; targets: Element[] };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      disconnect() { this.entry.targets = []; }
      unobserve() {}
      takeRecords() { return []; }
    });
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob: new Blob(["png"]) });
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));

    expect(mocks.downloadChatAttachment).not.toHaveBeenCalled();
    const placeholder = container.querySelector('[data-testid="chat-image-attachment-placeholder"]');
    expect(placeholder?.getAttribute("aria-label")).toBe("Loading shot.png");
    const observer = observers.find((entry) => entry.targets.length > 0)!;
    await act(async () => {
      observer.callback(
        [{ isIntersecting: true, target: observer.targets[0] } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(mocks.downloadChatAttachment).toHaveBeenCalledExactlyOnceWith(STORAGE_PATH);
    expect(container.querySelector('[data-testid="chat-image-attachment-thumbnail"]')).not.toBeNull();
  });

  it("never loads a preview URL another member wrote into the metadata", async () => {
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob: new Blob(["png"]) });
    const message = messageWith([
      { kind: "image", storagePath: STORAGE_PATH, previewUrl: "https://tracker.example/pixel.png" },
      { kind: "image", previewUrl: "https://tracker.example/other.png" },
    ]);
    expect(extractChatAttachments(message)).toEqual([
      expect.objectContaining({ storagePath: STORAGE_PATH, previewUrl: null }),
    ]);
    await renderBubble(message);
    expect(mocks.downloadChatAttachment).toHaveBeenCalledWith(STORAGE_PATH);
    expect(container.innerHTML).not.toContain("tracker.example");
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

  it("retries legacy image URL failures and failed image loads", async () => {
    mocks.getWorkspaceFileRawUrl.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("https://controller.example/raw/photo.png");
    await renderBubble(messageWith([{ kind: "image", workspacePath: "photo.png", fileName: "photo.png" }]));
    expect(container.querySelector('[data-testid="chat-image-attachment-placeholder"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-image-attachment-retry"]')?.click());
    const image = container.querySelector<HTMLImageElement>('[data-testid="chat-image-attachment-thumbnail"] img');
    expect(image?.src).toBe("https://controller.example/raw/photo.png");
    await act(async () => image?.dispatchEvent(new Event("error")));
    expect(container.querySelector('[data-testid="chat-image-attachment-retry"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-image-attachment-retry"]')?.click());
    expect(mocks.getWorkspaceFileRawUrl).toHaveBeenCalledTimes(3);
  });

  it("does not keep a legacy image from the previous space while its replacement is loading", async () => {
    mocks.getWorkspaceFileRawUrl.mockResolvedValueOnce("https://controller.example/raw/old.png")
      .mockImplementationOnce(() => new Promise(() => {}));
    const message = messageWith([{ kind: "image", workspacePath: "photo.png", fileName: "photo.png" }]);
    await renderBubble(message);
    await act(async () => root.render(<UserMessageBubble message={message} projectId="another-project" />));
    expect(container.querySelector('[data-testid="chat-image-attachment-placeholder"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows an unavailable tile for image bytes the browser cannot decode", async () => {
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob: new Blob(["invalid image"]) });
    await renderBubble(messageWith([{ kind: "image", storagePath: STORAGE_PATH, fileName: "shot.png" }]));
    await act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")));
    expect(container.querySelector('[data-testid="chat-image-attachment-unavailable"]')?.textContent).toBe("Image unavailable");
  });

  it("opens attached text with the session, renders it literally, and returns focus on Escape", async () => {
    const content = "<script>secret()</script>\n# Notes";
    const blob = new NodeBlob([content], { type: "text/plain" });
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob });
    await renderBubble(messageWith([{ kind: "file", storagePath: TEXT_PATH, fileName: "notes.txt" }]));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-attachment"]')!;
    const draft = document.createElement("input");
    container.appendChild(draft);
    draft.value = "Keep this draft";
    draft.focus();
    // A touch press can leave the editor focused before the opener handles it.
    await act(async () => trigger.click());
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)); });
    expect(mocks.downloadChatAttachment).toHaveBeenCalledExactlyOnceWith(TEXT_PATH);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("notes.txt");
    expect(dialog.querySelector('[data-testid="chat-file-attachment-content"]')?.textContent).toBe(content);
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(draft.value).toBe("Keep this draft");
  });

  it("drops a private text viewer when the signed-in person changes", async () => {
    let settle!: (value: { ok: true; blob: Blob }) => void;
    mocks.downloadChatAttachment.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await renderBubble(messageWith([{ kind: "file", storagePath: TEXT_PATH, fileName: "notes.txt" }]));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-attachment"]')?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      for (const listener of mocks.authListeners) listener("SIGNED_IN", { user: { id: "reader-two" } });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => settle({ ok: true, blob: new Blob(["private contents"]) }));
    expect(document.body.textContent).not.toContain("private contents");
  });

  it("pages long text without downloading it again and keeps the page through token refresh", async () => {
    const firstPage = "a".repeat(TEXT_ATTACHMENT_PAGE_BYTES - 1);
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob: new NodeBlob([`${firstPage}🐙tail`]) });
    await renderBubble(messageWith([{ kind: "file", storagePath: TEXT_PATH, fileName: "notes.txt" }]));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-attachment"]')?.click());
    const findButton = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === name);
    expect(document.querySelector('[data-testid="chat-file-attachment-content"]')?.textContent).toBe(firstPage);
    expect(findButton("Previous")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => findButton("Next")?.click());
    expect(document.querySelector('[data-testid="chat-file-attachment-content"]')?.textContent).toBe("🐙tail");
    expect(findButton("Next")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      for (const listener of mocks.authListeners) listener("TOKEN_REFRESHED", { user: { id: "reader-one" } });
    });
    expect(document.querySelector('[data-testid="chat-file-attachment-content"]')?.textContent).toBe("🐙tail");
    await act(async () => findButton("Previous")?.click());
    expect(document.querySelector('[data-testid="chat-file-attachment-content"]')?.textContent).toBe(firstPage);
    expect(mocks.downloadChatAttachment).toHaveBeenCalledExactlyOnceWith(TEXT_PATH);
  });

  it("keeps focus on paging controls through loading and at either end", async () => {
    const blob = new NodeBlob(["a".repeat(250 * 1024)]);
    const originalSlice = blob.slice.bind(blob);
    let releasePage!: () => void;
    const pendingPage = new Promise<void>((resolve) => { releasePage = resolve; });
    vi.spyOn(blob, "slice").mockImplementation((start, end, type) => {
      const part = originalSlice(start, end, type);
      if (start === TEXT_ATTACHMENT_PAGE_BYTES) {
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => { await pendingPage; return read(); };
      }
      return part;
    });
    mocks.downloadChatAttachment.mockResolvedValue({ ok: true, blob });
    await renderBubble(messageWith([{ kind: "file", storagePath: TEXT_PATH, fileName: "long-notes.txt" }]));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-attachment"]')?.click());
    const findButton = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.includes(name))!;
    const next = findButton("Next");
    const previous = findButton("Previous");
    const activateFocused = async (button: HTMLButtonElement) => {
      await act(async () => {
        button.focus();
        button.click();
      });
    };
    await activateFocused(next);
    expect(document.querySelector('[data-testid="chat-file-attachment-content"]') === null).toBe(true);
    expect(document.activeElement).toBe(next);
    expect(next.disabled).toBe(false);
    await act(async () => releasePage());
    expect(document.activeElement).toBe(next);
    await activateFocused(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(next);
    await activateFocused(next);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Page 3");
    await activateFocused(previous);
    await activateFocused(previous);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(previous.disabled).toBe(false);
    expect(document.activeElement).toBe(previous);
    await activateFocused(previous);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Page 1");
  });

  it("retries a text attachment download and reports a refused read without exposing its details", async () => {
    mocks.downloadChatAttachment.mockResolvedValueOnce({ ok: false, reason: "transient" })
      .mockResolvedValueOnce({ ok: false, reason: "refused" });
    await renderBubble(messageWith([{ kind: "file", storagePath: TEXT_PATH, fileName: "notes.txt" }]));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-attachment"]')?.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load attachment");
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "Try again");
    retry?.focus();
    await act(async () => retry?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This attachment is unavailable.");
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    expect(mocks.downloadChatAttachment).toHaveBeenCalledTimes(2);
    expect(mocks.getWorkspaceFileRawUrl).not.toHaveBeenCalled();
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });
});
