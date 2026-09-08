// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatComposerAttachments } from "../useChatComposerAttachments";

type Attachments = ReturnType<typeof useChatComposerAttachments>;
let latest: Attachments;
const showStatus = vi.fn();

function Probe({ draftKey }: { draftKey: string }) {
  latest = useChatComposerAttachments({ draftKey, isInputLocked: () => false, showStatus });
  return <div>{latest.imageAttachments.map((attachment) => (
    <img key={attachment.id} src={attachment.previewUrl} alt={attachment.file.name} />
  ))}</div>;
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

  it("clears only submitted file identities in the source chat after more images are added", async () => {
    await select("chat-a");
    await attach("same.png");
    const submittedFiles = latest.imageAttachments.map((attachment) => attachment.file);
    const completeUpload = latest.clearSubmittedImageAttachments;
    await attach("same.png");
    await select("chat-b");
    await attach("b.png");
    await act(async () => completeUpload(submittedFiles));
    expect(names()).toEqual(["b.png"]);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:attachment-1");
    await select("chat-a");
    expect(names()).toEqual(["same.png"]);
    expect(latest.imageAttachments[0].file).not.toBe(submittedFiles[0]);
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

  it("keeps image type and size validation unchanged", async () => {
    await select("chat-a");
    await act(async () => latest.attachImageFiles([
      new File(["text"], "notes.txt", { type: "text/plain" }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
      new File(["image"], "valid.png", { type: "image/png" }),
    ]));
    expect(names()).toEqual(["valid.png"]);
    expect(showStatus).toHaveBeenCalledWith("Skipped non-image files.", "info", 3000);
    expect(showStatus).toHaveBeenCalledWith("Skipped image(s) larger than 5MB.", "error", 4000);
  });
});
