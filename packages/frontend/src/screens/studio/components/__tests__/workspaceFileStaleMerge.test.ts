import { describe, expect, it, vi } from "vitest";
import { sanitizeChatUploadFileName } from "../../../../conversations/conversationSubmitHelpers";
import { ChatAttachmentUploadError } from "../../../../lib/chatAttachments";
import {
  buildWorkspaceFileStaleMergeRequest,
  MERGE_SNAPSHOT_INLINE_FALLBACK_LIMIT,
  MERGE_SNAPSHOT_INLINE_LIMIT,
  sendWorkspaceFileStaleMerge,
} from "../workspaceFileStaleMerge";

const large = (seed: string) => seed.repeat(Math.ceil(MERGE_SNAPSHOT_INLINE_LIMIT / seed.length));

describe("buildWorkspaceFileStaleMergeRequest", () => {
  it("sends large versions as two attached text snapshots, never as workspace files", async () => {
    const notice = { path: "src/app/App.tsx", baseText: large("base\n"), localText: large("mine\n") };
    const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: true });

    expect(textFiles.map((file) => [file.name, file.type])).toEqual([
      ["App.tsx.base.txt", "text/plain"],
      ["App.tsx.local.txt", "text/plain"],
    ]);
    expect(await textFiles[0].text()).toBe(notice.baseText);
    expect(await textFiles[1].text()).toBe(notice.localText);
    expect(prompt).toContain("the attached file App.tsx.base.txt");
    expect(prompt).toContain("the attached file App.tsx.local.txt");
    expect(prompt).toContain("Read the two attached snapshot files.");
    expect(prompt).not.toContain("artifacts/instafy-merge");
    expect(prompt).not.toContain(notice.baseText);
  });

  it("keeps an empty base as an empty snapshot", async () => {
    const { textFiles } = buildWorkspaceFileStaleMergeRequest(
      { path: "notes.md", baseText: "", localText: `${large("new\n")}more` },
      { canAttachFiles: true },
    );
    expect(textFiles[0].size).toBe(0);
    expect(textFiles[0].name).toBe("notes.md.base.txt");
  });

  it("keeps small versions inline", () => {
    const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(
      { path: "src/lib.rs", baseText: "fn a() {}", localText: "fn b() {}" },
      { canAttachFiles: true },
    );
    expect(textFiles).toEqual([]);
    expect(prompt).toContain("```rust\nfn a() {}\n```");
    expect(prompt).toContain("```rust\nfn b() {}\n```");
  });

  it("keeps every size inline when this server can't store attachments", () => {
    const notice = { path: "README.md", baseText: large("a"), localText: large("b") };
    const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: false });
    expect(textFiles).toEqual([]);
    expect(prompt).toContain(notice.localText);
  });

  it.each([70, 71, 72, 79, 80, 120])(
    "names a %i-character file's snapshots exactly as the message records them, and apart",
    (length) => {
      const fileName = `${"a".repeat(length - 4)}.tsx`;
      const notice = { path: `src/${fileName}`, baseText: large("base\n"), localText: large("mine\n") };
      const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: true });
      const [base, local] = textFiles.map((file) => file.name);

      // What uploadConversationAttachments records as each fileName.
      expect(sanitizeChatUploadFileName(base)).toBe(base);
      expect(sanitizeChatUploadFileName(local)).toBe(local);
      expect(base).not.toBe(local);
      expect(base.endsWith(".tsx.base.txt")).toBe(true);
      expect(local.endsWith(".tsx.local.txt")).toBe(true);
      expect(prompt).toContain(`the attached file ${base}\n`);
      expect(prompt).toContain(`the attached file ${local}\n`);
    },
  );
});

describe("sendWorkspaceFileStaleMerge", () => {
  const largeNotice = { path: "src/app/App.tsx", baseText: large("base\n"), localText: large("mine\n") };

  it("attaches large versions as two text files when the server stores attachments", async () => {
    const submit = vi.fn(async () => undefined);
    await sendWorkspaceFileStaleMerge({ notice: largeNotice, chatAttachments: "storage", submit });

    expect(submit).toHaveBeenCalledTimes(1);
    const [prompt, options] = submit.mock.calls[0] as unknown as [string, { textFiles: File[]; callerReportsAttachmentErrors: boolean }];
    expect(prompt).toContain("the attached file App.tsx.base.txt");
    expect(options.textFiles.map((file) => [file.name, file.type])).toEqual([
      ["App.tsx.base.txt", "text/plain"],
      ["App.tsx.local.txt", "text/plain"],
    ]);
    // The merge notice shows a failure; the submit flow does not repeat it.
    expect(options.callerReportsAttachmentErrors).toBe(true);
  });

  it("also attaches them while the server has not said (an older controller)", async () => {
    const submit = vi.fn(async () => undefined);
    await sendWorkspaceFileStaleMerge({ notice: largeNotice, chatAttachments: null, submit });
    expect((submit.mock.calls[0] as unknown[])[1]).toMatchObject({ textFiles: expect.any(Array) });
  });

  it("keeps large versions inline, with no files, when the server can't store attachments", async () => {
    const submit = vi.fn(async () => undefined);
    await sendWorkspaceFileStaleMerge({ notice: largeNotice, chatAttachments: "none", submit });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual([expect.stringContaining(largeNotice.localText)]);
  });

  it("sends the request once more inline when the snapshots can't be stored", async () => {
    const submit = vi
      .fn<(prompt: string, options?: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new ChatAttachmentUploadError("Storage isn't responding right now. Try again in a moment."))
      .mockResolvedValueOnce(undefined);
    await sendWorkspaceFileStaleMerge({ notice: largeNotice, chatAttachments: "storage", submit });

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual([expect.stringContaining(largeNotice.localText)]);
  });

  it("gives the notice the plain upload error when the versions are too long to send inline", async () => {
    const huge = "x".repeat(MERGE_SNAPSHOT_INLINE_FALLBACK_LIMIT);
    const failure = new ChatAttachmentUploadError("You can't add attachments to this chat.");
    const submit = vi.fn(async () => {
      throw failure;
    });
    await expect(
      sendWorkspaceFileStaleMerge({
        notice: { path: "big.json", baseText: huge, localText: "{}" },
        chatAttachments: "storage",
        submit,
      }),
    ).rejects.toBe(failure);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not resend after a failure that is not about attachments", async () => {
    const submit = vi.fn(async () => {
      throw new Error("Controller unavailable");
    });
    await expect(
      sendWorkspaceFileStaleMerge({ notice: largeNotice, chatAttachments: "storage", submit }),
    ).rejects.toThrow("Controller unavailable");
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
