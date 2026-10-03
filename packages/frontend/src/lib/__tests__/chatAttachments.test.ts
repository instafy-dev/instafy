import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  config: { enabled: true },
  from: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../supabaseClient", () => ({
  get hasSupabaseConfig() {
    return storage.config.enabled;
  },
  supabase: { storage: { from: storage.from } },
}));

import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENTS_UNAVAILABLE_REASON,
  CHAT_IMAGE_ACCEPT,
  ChatAttachmentUploadError,
  chatAttachmentFileProblem,
  chatAttachmentObjectName,
  describeChatAttachmentUploadError,
  downloadChatAttachment,
  isChatAttachmentStoragePath,
  removeChatAttachments,
  uploadChatAttachment,
} from "../chatAttachments";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const CONVERSATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OBJECT = "0f0f0f0f-1111-4222-8333-444444444444";
const LOWER_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

describe("chat attachment names", () => {
  it("names an object <projectId>/<conversationId>/<uuid>.<ext> in lower case", () => {
    expect(chatAttachmentObjectName(PROJECT.toUpperCase(), ` ${CONVERSATION.toUpperCase()} `, "image/png", OBJECT.toUpperCase()))
      .toBe(`${PROJECT}/${CONVERSATION}/${OBJECT}.png`);
    expect(chatAttachmentObjectName(PROJECT, CONVERSATION, "image/jpeg", OBJECT)).toMatch(/\.jpg$/);
    expect(chatAttachmentObjectName(PROJECT, CONVERSATION, "image/webp", OBJECT)).toMatch(/\.webp$/);
    expect(chatAttachmentObjectName(PROJECT, CONVERSATION, "image/gif", OBJECT)).toMatch(/\.gif$/);
    expect(chatAttachmentObjectName(PROJECT, CONVERSATION, "text/plain", OBJECT)).toMatch(/\.txt$/);
    expect(chatAttachmentObjectName(PROJECT, CONVERSATION, "text/markdown", OBJECT)).toMatch(/\.md$/);
    const generated = chatAttachmentObjectName(PROJECT, CONVERSATION, "image/png");
    expect(generated.split("/")).toHaveLength(3);
    expect(generated).toMatch(new RegExp(`^${PROJECT}/${CONVERSATION}/${LOWER_UUID}\\.png$`));
  });

  it("refuses a destination that is not a canonical uuid", () => {
    for (const [project, conversation] of [
      ["space-1", CONVERSATION],
      [PROJECT, "../other"],
      [PROJECT, ""],
      [`${PROJECT}/x`, CONVERSATION],
    ]) {
      expect(() => chatAttachmentObjectName(project, conversation, "image/png", OBJECT)).toThrow();
    }
  });

  it("recognizes only names of the bucket's own shape", () => {
    expect(isChatAttachmentStoragePath(`${PROJECT}/${CONVERSATION}/${OBJECT}.png`)).toBe(true);
    expect(isChatAttachmentStoragePath(`${PROJECT}/${CONVERSATION}/${OBJECT}.md`)).toBe(true);
    for (const value of [
      `${PROJECT}/${OBJECT}.png`,
      `${PROJECT}/${CONVERSATION}/${OBJECT.toUpperCase()}.png`,
      `${PROJECT}/${CONVERSATION}/${OBJECT}.svg`,
      `${PROJECT}/${CONVERSATION}/../${OBJECT}.png`,
      `chat-upload-1-${OBJECT}-photo.png`,
      null,
      42,
    ]) {
      expect(isChatAttachmentStoragePath(value)).toBe(false);
    }
  });

  it("offers only the image types the bucket takes", () => {
    expect(CHAT_IMAGE_ACCEPT).toBe("image/png,image/jpeg,image/webp,image/gif");
    expect(chatAttachmentFileProblem({ type: "image/svg+xml", size: 10 })).toBe("type");
    expect(chatAttachmentFileProblem({ type: "image/heic", size: 10 })).toBe("type");
    expect(chatAttachmentFileProblem({ type: "image/png", size: 0 })).toBe("empty");
    expect(chatAttachmentFileProblem({ type: "text/plain", size: 0 })).toBeNull();
    expect(chatAttachmentFileProblem({ type: "image/png", size: CHAT_ATTACHMENT_MAX_BYTES })).toBeNull();
    expect(chatAttachmentFileProblem({ type: "image/png", size: CHAT_ATTACHMENT_MAX_BYTES + 1 })).toBe("size");
  });
});

describe("chat attachment storage", () => {
  beforeEach(() => {
    storage.config.enabled = true;
    storage.upload.mockReset().mockResolvedValue({ data: { path: "x" }, error: null });
    storage.download.mockReset();
    storage.remove.mockReset().mockResolvedValue({ data: [], error: null });
    storage.from.mockReset().mockReturnValue({
      upload: storage.upload,
      download: storage.download,
      remove: storage.remove,
    });
  });

  it("uploads with the session to the private bucket, never overwriting, and records the metadata shape", async () => {
    const file = new File(["png"], "Screen Shot.png", { type: "image/png" });
    const attachment = await uploadChatAttachment({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      file,
      fileName: "Screen-Shot.png",
    });
    expect(storage.from).toHaveBeenCalledWith("chat-attachments");
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [path, body, options] = storage.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${PROJECT}/${CONVERSATION}/${LOWER_UUID}\\.png$`));
    expect(body).toBe(file);
    expect(options).toEqual({ upsert: false, contentType: "image/png" });
    expect(attachment).toEqual({
      kind: "image",
      storagePath: path,
      fileName: "Screen-Shot.png",
      mimeType: "image/png",
      sizeBytes: 3,
    });
  });

  it("stores text as kind file with the exact type the bucket checks", async () => {
    const file = new File(["# notes"], "notes.md", { type: "text/markdown;charset=utf-8" });
    const attachment = await uploadChatAttachment({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      file,
      fileName: "notes.md",
    });
    const [path, body, options] = storage.upload.mock.calls[0];
    expect(path).toMatch(/\.md$/);
    expect((body as File).type).toBe("text/markdown");
    expect(options.contentType).toBe("text/markdown");
    expect(attachment).toMatchObject({ kind: "file", mimeType: "text/markdown", sizeBytes: 7 });
  });

  it("refuses unsupported or oversized files before any upload", async () => {
    for (const file of [
      new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }),
      new File([new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1)], "big.png", { type: "image/png" }),
    ]) {
      await expect(
        uploadChatAttachment({ projectId: PROJECT, conversationId: CONVERSATION, file, fileName: file.name }),
      ).rejects.toBeInstanceOf(ChatAttachmentUploadError);
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("maps Storage refusals to plain copy and never shows Storage's own wording", async () => {
    storage.upload.mockResolvedValue({
      data: null,
      error: { message: "new row violates row-level security policy", status: 400, statusCode: "403" },
    });
    const upload = uploadChatAttachment({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      file: new File(["png"], "x.png", { type: "image/png" }),
      fileName: "x.png",
    });
    await expect(upload).rejects.toThrow("You can't add attachments to this chat.");
    await expect(upload).rejects.not.toThrow(/row-level/);
  });

  it.each([
    [{ message: "The object exceeded the maximum allowed size", status: 400, statusCode: "413" }, "Attachments must be 20 MB or smaller."],
    [{ message: "mime type image/svg+xml is not supported", status: 400, statusCode: "415" }, "Only PNG, JPEG, WebP and GIF images can be attached."],
    [{ message: "Bucket not found", status: 400, statusCode: "404" }, CHAT_ATTACHMENTS_UNAVAILABLE_REASON],
    [{ message: "jwt expired", status: 400, statusCode: "403" }, "Your sign-in has expired. Reload the page and try again."],
    [{ message: "Too many requests", status: 429, statusCode: "429" }, "Too many uploads at once. Wait a moment and try again."],
    [{ message: "internal", status: 502, statusCode: "502" }, "Storage isn't responding right now. Try again in a moment."],
    [new TypeError("Failed to fetch"), "Couldn't reach storage. Check your connection and try again."],
    [{ message: "The resource already exists", status: 409, statusCode: "409" }, "Couldn't upload the attachment. Try again."],
  ])("describes %j in plain copy", (error, copy) => {
    expect(describeChatAttachmentUploadError(error)).toBe(copy);
  });

  it("says attachments are unavailable on an install without Supabase", async () => {
    storage.config.enabled = false;
    await expect(
      uploadChatAttachment({
        projectId: PROJECT,
        conversationId: CONVERSATION,
        file: new File(["png"], "x.png", { type: "image/png" }),
        fileName: "x.png",
      }),
    ).rejects.toThrow(CHAT_ATTACHMENTS_UNAVAILABLE_REASON);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("downloads with the session and reports a refused or failed read as unavailable", async () => {
    const path = `${PROJECT}/${CONVERSATION}/${OBJECT}.png`;
    const blob = new Blob(["png"], { type: "image/png" });
    storage.download.mockResolvedValueOnce({ data: blob, error: null });
    await expect(downloadChatAttachment(path)).resolves.toEqual({ ok: true, blob });
    expect(storage.from).toHaveBeenCalledWith("chat-attachments");
    expect(storage.download).toHaveBeenCalledWith(path);

    storage.download.mockResolvedValueOnce({ data: null, error: { message: "Object not found" } });
    await expect(downloadChatAttachment(path)).resolves.toEqual({ ok: false });
    storage.download.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(downloadChatAttachment(path)).resolves.toEqual({ ok: false });
  });

  it("never asks Storage for a name outside the bucket's shape", async () => {
    await expect(downloadChatAttachment("chat-upload-1-photo.png")).resolves.toEqual({ ok: false });
    await removeChatAttachments(["chat-upload-1-photo.png"]);
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
