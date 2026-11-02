// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSendingImages,
  formatAttachmentSize,
  useChatComposerAttachments,
} from "../useChatComposerAttachments";
import { StudioDraftsProvider } from "../../../../workspace/StudioDrafts";
import { ChatAttachmentDraftsProvider } from "../ChatAttachmentDrafts";

type Attachments = ReturnType<typeof useChatComposerAttachments>;
let latest: Attachments;
const showStatus = vi.fn();

function Probe({ draftKey, unavailableReason = null }: { draftKey: string; unavailableReason?: string | null }) {
  latest = useChatComposerAttachments({ draftKey, isInputLocked: () => false, showStatus, unavailableReason });
  return <div>
    <button disabled={latest.hasSendingAttachments}>Send</button>
    {latest.imageAttachments.map((attachment) => (
      <img key={attachment.id} src={attachment.previewUrl} alt={attachment.file.name} />
    ))}
  </div>;
}

describe("useChatComposerAttachments", () => {
  let root: Root;
  let container: HTMLDivElement;
  let objectUrlSequence: number;
  const revokeObjectURL = vi.fn();
  const names = () => [...container.querySelectorAll("img")].map((image) => image.alt);
  async function select(draftKey: string) {
    await act(async () => root.render(<Probe draftKey={draftKey} />));
  }
  async function attach(name: string) {
    await act(async () => latest.attachImageFiles([new File(["image"], name, { type: "image/png" })]));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    objectUrlSequence = 0;
    revokeObjectURL.mockReset();
    showStatus.mockReset();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return `blob:attachment-${++objectUrlSequence}`; }
      static revokeObjectURL = revokeObjectURL;
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

  it("restores each chat's image draft without transferring images during switching", async () => {
    await select("user-1:space-1:chat-a");
    await attach("a.png");
    const original = latest.imageAttachments[0];
    await select("user-1:space-1:chat-b");
    expect(names()).toEqual([]);
    await attach("b.png");
    expect(names()).toEqual(["b.png"]);
    await select("user-1:space-1:chat-a");
    expect(names()).toEqual(["a.png"]);
    expect(latest.imageAttachments[0]).toBe(original);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("keeps staged images when a Studio panel replaces the composer", async () => {
    const panel = (chat: boolean) => (
      <StudioDraftsProvider>
        <ChatAttachmentDraftsProvider>
          {chat ? <Probe draftKey="user-1:space-1:chat-a" /> : <div>Home</div>}
        </ChatAttachmentDraftsProvider>
      </StudioDraftsProvider>
    );
    await act(async () => root.render(panel(true)));
    await attach("screenshot.png");
    const original = latest.imageAttachments[0];
    await act(async () => root.render(panel(false)));
    await act(async () => root.render(panel(true)));
    expect(names()).toEqual(["screenshot.png"]);
    expect(latest.imageAttachments[0]).toBe(original);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("finishes an upload in its original draft while another panel is open", async () => {
    const panel = (chat: boolean) => (
      <ChatAttachmentDraftsProvider>
        {chat ? <Probe draftKey="chat-a" /> : <div>Settings</div>}
      </ChatAttachmentDraftsProvider>
    );
    await act(async () => root.render(panel(true)));
    await attach("sending.png");
    const originalSend = latest;
    const files = latest.imageAttachments.map(item => item.file);
    await act(async () => latest.markImageAttachmentsSending(files, true));
    await attach("next-message.png");
    await act(async () => root.render(panel(false)));
    // Return before the original request finishes: a new composer must not
    // offer to send the same uploading files a second time.
    await act(async () => root.render(panel(true)));
    expect(latest.hasSendingAttachments).toBe(true);
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () => originalSend.removeSentImageAttachments(files));
    expect(names()).toEqual(["next-message.png"]);
    expect(latest.hasSendingAttachments).toBe(false);
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:attachment-1");
  });

  it("releases every account's previews on sign out and ignores callbacks from it", async () => {
    const panel = (account: string, chat = "chat-a") => (
      <StrictMode>
        <ChatAttachmentDraftsProvider key={account}>
          <Probe draftKey={`${account}:${chat}`} />
        </ChatAttachmentDraftsProvider>
      </StrictMode>
    );
    await act(async () => root.render(panel("first")));
    await attach("a.png");
    const oldAccount = latest;
    await act(async () => root.render(panel("first", "chat-b")));
    await attach("b.png");
    await act(async () => root.render(panel("second")));
    expect(names()).toEqual([]);
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual([
      "blob:attachment-1", "blob:attachment-2",
    ]);
    await attach("new-account.png");
    await act(async () => oldAccount.attachImageFiles([new File(["image"], "late.png", { type: "image/png" })]));
    expect(names()).toEqual(["new-account.png"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment-4");
    await act(async () => root.render(panel("first")));
    expect(names()).toEqual([]);
  });

  it("keeps asynchronous send cleanup bound to the originating chat", async () => {
    await select("chat-a");
    await attach("a.png");
    const finishOriginalSend = latest.clearImageAttachments;
    await select("chat-b");
    await attach("b.png");
    await act(async () => finishOriginalSend());
    expect(names()).toEqual(["b.png"]);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:attachment-1");
    await select("chat-a");
    expect(names()).toEqual([]);
  });

  it("isolates identical chat IDs across user and project draft keys", async () => {
    await select(JSON.stringify(["user-1", "space-1", "chat"]));
    await attach("private.png");
    await select(JSON.stringify(["user-2", "space-1", "chat"]));
    expect(names()).toEqual([]);
    await select(JSON.stringify(["user-1", "space-2", "chat"]));
    expect(names()).toEqual([]);
    await select(JSON.stringify(["user-1", "space-1", "chat"]));
    expect(names()).toEqual(["private.png"]);
  });

  it("revokes removed and cleared URLs once and releases all retained drafts on unmount", async () => {
    await select("chat-a");
    await attach("remove.png");
    await attach("keep-a.png");
    const removedId = latest.imageAttachments[0].id;
    await act(async () => latest.removeImageAttachment(removedId));
    expect(names()).toEqual(["keep-a.png"]);
    await select("chat-b");
    await attach("clear.png");
    await act(async () => latest.clearImageAttachments());
    await attach("keep-b.png");
    await act(async () => root.unmount());
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual([
      "blob:attachment-1", "blob:attachment-2", "blob:attachment-3", "blob:attachment-4",
    ]);
    root = createRoot(container);
    await select("chat-a");
    expect(names()).toEqual([]);
  });

  it("takes only PNG, JPEG, WebP and GIF images up to the bucket's 20 MB", async () => {
    await select("chat-a");
    const limit = 20 * 1024 * 1024;
    await act(async () => latest.attachImageFiles([
      new File(["text"], "notes.txt", { type: "text/plain" }),
      new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
      new File(["heic"], "photo.heic", { type: "image/heic" }),
      new File([new Uint8Array(limit + 1)], "large.png", { type: "image/png" }),
      new File([new Uint8Array(limit)], "exactly-20mb.jpg", { type: "image/jpeg" }),
      new File(["image"], "valid.png", { type: "image/png" }),
      new File(["image"], "valid.webp", { type: "image/webp" }),
      new File(["image"], "valid.gif", { type: "image/gif" }),
    ]));
    expect(names()).toEqual(["exactly-20mb.jpg", "valid.png", "valid.webp", "valid.gif"]);
    expect(showStatus).toHaveBeenCalledWith("Only PNG, JPEG, WebP and GIF images can be attached.", "info", 4000);
    expect(showStatus).toHaveBeenCalledWith("Attachments must be 20 MB or smaller.", "error", 4000);
  });

  it("says why a pasted or dropped image of another type is not added", async () => {
    await select("chat-a");
    const heic = new File(["heic"], "photo.heic", { type: "image/heic" });
    const paste = { clipboardData: { items: [{ kind: "file", type: "image/heic", getAsFile: () => heic }] }, preventDefault: vi.fn() };
    await act(async () => latest.handleComposerPaste(paste as never));
    expect(paste.preventDefault).toHaveBeenCalled();
    expect(names()).toEqual([]);
    expect(showStatus).toHaveBeenCalledWith("Only PNG, JPEG, WebP and GIF images can be attached.", "info", 4000);

    const drop = {
      dataTransfer: { types: ["Files"], files: [new File(["pdf"], "doc.pdf", { type: "application/pdf" })] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    showStatus.mockReset();
    await act(async () => latest.handleComposerDrop(drop as never));
    expect(names()).toEqual([]);
    expect(showStatus).toHaveBeenCalledWith("Only PNG, JPEG, WebP and GIF images can be attached.", "info", 4000);
  });

  it("adds nothing and says why when this server can't store attachments", async () => {
    const reason = "This server can't store attachments.";
    await act(async () => root.render(<Probe draftKey="chat-a" unavailableReason={reason} />));
    const png = new File(["image"], "shot.png", { type: "image/png" });

    await act(async () => latest.attachImageFiles([png]));
    const paste = { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => png }] }, preventDefault: vi.fn() };
    await act(async () => latest.handleComposerPaste(paste as never));
    const drop = { dataTransfer: { types: ["Files"], files: [png] }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => latest.handleComposerDrop(drop as never));
    const dragOver = {
      dataTransfer: { types: ["Files"], items: [{ kind: "file", type: "image/png" }], dropEffect: "copy" },
      preventDefault: vi.fn(),
    };
    await act(async () => latest.handleComposerDragOver(dragOver as never));

    expect(names()).toEqual([]);
    expect(showStatus).toHaveBeenCalledTimes(3);
    for (const call of showStatus.mock.calls) {
      expect(call[0]).toBe(reason);
    }
    expect(paste.preventDefault).toHaveBeenCalled();
    // The drop has to land for the browser to fire it, so it can say why.
    expect(dragOver.dataTransfer.dropEffect).toBe("copy");
    expect(dragOver.preventDefault).toHaveBeenCalled();
  });

  it("describes sizes and the upload in plain copy", () => {
    expect(formatAttachmentSize(10)).toBe("1 KB");
    expect(formatAttachmentSize(640 * 1024)).toBe("640 KB");
    expect(formatAttachmentSize(20 * 1024 * 1024)).toBe("20.0 MB");
    expect(formatAttachmentSize(3.44 * 1024 * 1024)).toBe("3.4 MB");
    expect(describeSendingImages(1)).toBe("Sending your message with 1 image\u2026");
    expect(describeSendingImages(3)).toBe("Sending your message with 3 images\u2026");
  });

  it("leaves a plain text paste to the editor", async () => {
    await select("chat-a");
    const paste = { clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] }, preventDefault: vi.fn() };
    await act(async () => latest.handleComposerPaste(paste as never));
    expect(paste.preventDefault).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
  });
});
