// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatComposerAttachments } from "../useChatComposerAttachments";

type Attachments = ReturnType<typeof useChatComposerAttachments>;
let latest: Attachments;
const showStatus = vi.fn();
const onAttachmentsAdded = vi.fn();

function Probe({ draftKey, locked = false }: { draftKey: string; locked?: boolean }) {
  latest = useChatComposerAttachments({ draftKey, isInputLocked: () => locked, showStatus, onAttachmentsAdded });
  return <div>{latest.imageAttachments.map((attachment) => (
    <img key={attachment.id} src={attachment.previewUrl} alt={attachment.file.name} />
  ))}</div>;
}

describe("useChatComposerAttachments", () => {
  let root: Root;
  let container: HTMLDivElement;
  let objectUrlSequence: number;
  const revokeObjectURL = vi.fn();
  const createObjectURL = vi.fn();
  const names = () => [...container.querySelectorAll("img")].map((image) => image.alt);
  async function select(draftKey: string, locked = false) {
    await act(async () => root.render(<Probe draftKey={draftKey} locked={locked} />));
  }
  async function attach(name: string) {
    await act(async () => latest.attachImageFiles([new File(["image"], name, { type: "image/png" })]));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    objectUrlSequence = 0;
    revokeObjectURL.mockReset();
    createObjectURL.mockReset().mockImplementation(() => `blob:attachment-${++objectUrlSequence}`);
    showStatus.mockReset();
    onAttachmentsAdded.mockReset();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
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

  it("replaces one image in place without adding attachments or changing neighboring identities", async () => {
    await select("chat-a");
    await attach("first.png");
    await attach("middle.png");
    await attach("last.png");
    const [first, middle, last] = latest.imageAttachments;
    const edited = new File(["edited"], "middle-edited.png", { type: "image/png" });
    await act(async () => expect(latest.replaceImageAttachment(middle.id, middle.file, edited)).toBe(true));
    expect(names()).toEqual(["first.png", "middle-edited.png", "last.png"]);
    expect(latest.imageAttachments[0]).toBe(first);
    expect(latest.imageAttachments[2]).toBe(last);
    expect(latest.imageAttachments[1]).toMatchObject({ id: middle.id, previewUrl: "blob:attachment-4" });
    expect(latest.imageAttachments[1].file).toBe(edited);
    expect(latest.imageAttachments[1].originalFile).toBe(middle.file);
    expect(createObjectURL).toHaveBeenCalledTimes(4);
    expect(createObjectURL).toHaveBeenLastCalledWith(edited);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(middle.previewUrl);
    expect(onAttachmentsAdded).toHaveBeenCalledTimes(3);
  });

  it("preserves the first original across repeated replacements and removes it on restore", async () => {
    await select("chat-a");
    await attach("original.png");
    const original = latest.imageAttachments[0];
    const firstEdit = new File(["first edit"], "first-edit.png", { type: "image/png" });
    const secondEdit = new File(["second edit"], "second-edit.png", { type: "image/png" });
    await act(async () => expect(latest.replaceImageAttachment(original.id, original.file, firstEdit)).toBe(true));
    await act(async () => expect(latest.replaceImageAttachment(original.id, firstEdit, secondEdit)).toBe(true));
    expect(latest.imageAttachments[0].originalFile).toBe(original.file);
    await act(async () => expect(latest.restoreImageAttachment(original.id, secondEdit)).toBe(true));
    expect(latest.imageAttachments[0].file).toBe(original.file);
    expect(latest.imageAttachments[0]).not.toHaveProperty("originalFile");
    expect(latest.imageAttachments[0].id).toBe(original.id);
    expect(names()).toEqual(["original.png"]);
    expect(createObjectURL.mock.calls.map(([file]) => file)).toEqual([original.file, firstEdit, secondEdit, original.file]);
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(["blob:attachment-1", "blob:attachment-2", "blob:attachment-3"]);
    await act(async () => expect(latest.restoreImageAttachment(original.id, original.file)).toBe(false));
    expect(createObjectURL).toHaveBeenCalledTimes(4);
    expect(onAttachmentsAdded).toHaveBeenCalledOnce();
  });

  it("rejects edit and restore completions after switching chats and preserves both drafts", async () => {
    await select("chat-a");
    await attach("a.png");
    const original = latest.imageAttachments[0];
    const edited = new File(["edited"], "a-edited.png", { type: "image/png" });
    await act(async () => { latest.replaceImageAttachment(original.id, original.file, edited); });
    const saved = latest.imageAttachments[0];
    const finishEdit = latest.replaceImageAttachment;
    const finishRestore = latest.restoreImageAttachment;
    await select("chat-b");
    await attach("b.png");
    const other = latest.imageAttachments[0];
    await act(async () => {
      expect(finishEdit(saved.id, saved.file, original.file)).toBe(false);
      expect(finishRestore(saved.id, saved.file)).toBe(false);
    });
    expect(latest.imageAttachments[0]).toBe(other);
    expect(names()).toEqual(["b.png"]);
    await select("chat-a");
    expect(latest.imageAttachments[0]).toBe(saved);
    expect(createObjectURL).toHaveBeenCalledTimes(3);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(original.previewUrl);
  });

  it("rejects removed and stale file snapshots even when filenames match", async () => {
    await select("chat-a");
    await attach("same.png");
    const original = latest.imageAttachments[0];
    const edited = new File(["edited"], "same.png", { type: "image/png" });
    await act(async () => { latest.replaceImageAttachment(original.id, original.file, edited); });
    const saved = latest.imageAttachments;
    await act(async () => {
      expect(latest.replaceImageAttachment(original.id, original.file, original.file)).toBe(false);
      expect(latest.restoreImageAttachment(original.id, original.file)).toBe(false);
    });
    expect(latest.imageAttachments).toBe(saved);
    await act(async () => latest.removeImageAttachment(original.id));
    await attach("same.png");
    const other = latest.imageAttachments[0];
    await act(async () => {
      expect(latest.replaceImageAttachment(original.id, edited, original.file)).toBe(false);
      expect(latest.restoreImageAttachment(original.id, edited)).toBe(false);
    });
    expect(latest.imageAttachments[0]).toBe(other);
    expect(createObjectURL).toHaveBeenCalledTimes(3);
  });

  it("keeps an edited image when an older upload snapshot clears and rejects edits after the current upload clears", async () => {
    await select("chat-a");
    await attach("original.png");
    const original = latest.imageAttachments[0];
    const finishUpload = latest.clearSubmittedImageAttachments;
    const finishEdit = latest.replaceImageAttachment;
    const edited = new File(["edited"], "edited.png", { type: "image/png" });
    await act(async () => { latest.replaceImageAttachment(original.id, original.file, edited); });
    await act(async () => finishUpload([original.file]));
    expect(names()).toEqual(["edited.png"]);
    expect(latest.imageAttachments[0].originalFile).toBe(original.file);
    await act(async () => finishUpload([edited]));
    await act(async () => {
      expect(finishEdit(original.id, original.file, edited)).toBe(false);
      expect(latest.restoreImageAttachment(original.id, edited)).toBe(false);
    });
    expect(names()).toEqual([]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(["blob:attachment-1", "blob:attachment-2"]);
  });

  it("uses the current input lock even for previously captured edit and restore callbacks", async () => {
    await select("chat-a");
    await attach("original.png");
    const original = latest.imageAttachments[0];
    const edited = new File(["edited"], "edited.png", { type: "image/png" });
    await act(async () => { latest.replaceImageAttachment(original.id, original.file, edited); });
    const finishEdit = latest.replaceImageAttachment;
    const finishRestore = latest.restoreImageAttachment;
    const saved = latest.imageAttachments[0];
    await select("chat-a", true);
    await act(async () => {
      expect(finishEdit(original.id, edited, original.file)).toBe(false);
      expect(finishRestore(original.id, edited)).toBe(false);
    });
    expect(latest.imageAttachments[0]).toBe(saved);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid replacement images before allocating or changing state and accepts exactly 5MiB", async () => {
    await select("chat-a");
    await attach("original.png");
    const original = latest.imageAttachments[0];
    for (const invalid of [
      new File(["text"], "not-image.txt", { type: "text/plain" }),
      new File(["unknown"], "unknown.png"),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "too-large.png", { type: "image/png" }),
    ]) {
      expect(() => latest.replaceImageAttachment(original.id, original.file, invalid)).toThrow(/image|5MB/);
      expect(latest.imageAttachments[0]).toBe(original);
    }
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    const limitImage = new File([new Uint8Array(5 * 1024 * 1024)], "limit.png", { type: "image/png" });
    await act(async () => expect(latest.replaceImageAttachment(original.id, original.file, limitImage)).toBe(true));
    expect(latest.imageAttachments[0].file).toBe(limitImage);
  });

  it("preserves the existing image and original if preview allocation throws during replacement or restore", async () => {
    await select("chat-a");
    await attach("original.png");
    const original = latest.imageAttachments[0];
    const edited = new File(["edited"], "edited.png", { type: "image/png" });
    const allocationError = new Error("Unable to allocate image preview");
    createObjectURL.mockImplementationOnce(() => { throw allocationError; });
    expect(() => latest.replaceImageAttachment(original.id, original.file, edited)).toThrow(allocationError);
    expect(latest.imageAttachments[0]).toBe(original);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { latest.replaceImageAttachment(original.id, original.file, edited); });
    const saved = latest.imageAttachments[0];
    createObjectURL.mockImplementationOnce(() => { throw allocationError; });
    expect(() => latest.restoreImageAttachment(original.id, edited)).toThrow(allocationError);
    expect(latest.imageAttachments[0]).toBe(saved);
    expect(latest.imageAttachments[0].originalFile).toBe(original.file);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(original.previewUrl);
  });

  it("owns one live URL per edited image and releases edited inactive drafts on unmount", async () => {
    await select("chat-a");
    await attach("a.png");
    const originalA = latest.imageAttachments[0];
    const editedA = new File(["edited a"], "a-edited.png", { type: "image/png" });
    await act(async () => { latest.replaceImageAttachment(originalA.id, originalA.file, editedA); });
    const finishEditA = latest.replaceImageAttachment;
    await select("chat-b");
    await attach("b.png");
    const originalB = latest.imageAttachments[0];
    const editedB = new File(["edited b"], "b-edited.png", { type: "image/png" });
    await act(async () => { latest.replaceImageAttachment(originalB.id, originalB.file, editedB); });
    await act(async () => { latest.restoreImageAttachment(originalB.id, editedB); });
    await act(async () => latest.removeImageAttachment(originalB.id));
    await act(async () => root.unmount());
    expect(createObjectURL).toHaveBeenCalledTimes(5);
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual([
      "blob:attachment-1", "blob:attachment-2", "blob:attachment-3", "blob:attachment-4", "blob:attachment-5",
    ]);
    expect(finishEditA(originalA.id, editedA, originalA.file)).toBe(false);
    expect(createObjectURL).toHaveBeenCalledTimes(5);
    root = createRoot(container);
  });
});
