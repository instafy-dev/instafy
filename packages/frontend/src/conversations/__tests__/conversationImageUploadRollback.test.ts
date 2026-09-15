import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OriginApplyOptions } from "../../services/runtimeController/workspaceApply";
import type { ControllerRequestContext } from "../../services/runtimeController/core";
import { uploadConversationImageAttachments } from "../conversationSubmitHelpers";

const { applyChanges } = vi.hoisted(() => ({ applyChanges: vi.fn() }));
vi.mock("../../sdk/instafy", () => ({
  controllerClient: { workspace: { origin: { applyChanges } } },
}));

const PROJECT = "upload-test-project";
const RUNTIME = "upload-test-runtime";
const ORIGIN = "upload-test-origin";
const UPLOAD_FAILURE = "origin apply failed (403): image rejected";
const UNRELATED_PATH = "chat-upload-other-draft.png";
const UNRELATED_BYTES = new Uint8Array([90, 91, 92]);
type ApplyTarget = {
  projectId: string;
  originId: string;
  runtimeId: string | null;
  requestContext: ControllerRequestContext;
};
type PinnedApplyOptions = OriginApplyOptions & { target?: ApplyTarget };
const TARGET: ApplyTarget = {
  projectId: PROJECT,
  originId: ORIGIN,
  runtimeId: RUNTIME,
  requestContext: {
    baseUrl: "https://controller-a.invalid",
    accessToken: "inert-upload-test-token-a",
    credentialSource: "fixed",
    generation: 7,
  },
};

function image(name: string, bytes: number[]) {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

/** A synthetic filesystem at the SDK boundary, including writes whose reply
 * fails after their bytes reached storage. It never uses real transport. */
function originFilesystem(options: {
  failWrite?: number;
  throwWrite?: Error;
  failDelete?: string | Error;
} = {}) {
  const files = new Map<string, Uint8Array>([[UNRELATED_PATH, UNRELATED_BYTES]]);
  const attemptedWrites: string[] = [];
  const attemptedDeletes: string[] = [];
  applyChanges.mockImplementation(async (params: OriginApplyOptions) => {
    expect(params.projectId).toBe(PROJECT);
    expect(params.runtimeId).toBe(RUNTIME);
    for (const file of params.files) {
      attemptedWrites.push(file.path);
      // Persist before reporting failure: callers cannot assume a rejected
      // response means that the origin did not apply the write.
      files.set(file.path, new Uint8Array(file.bytes ?? []));
      if (attemptedWrites.length === options.failWrite) {
        if (options.throwWrite) throw options.throwWrite;
        return { ok: false, error: UPLOAD_FAILURE, target: TARGET };
      }
    }
    for (const path of params.deletes ?? []) {
      attemptedDeletes.push(path);
      if (options.failDelete instanceof Error) throw options.failDelete;
      if (options.failDelete) return { ok: false, error: options.failDelete, target: TARGET };
      files.delete(path);
    }
    return { ok: true, target: TARGET };
  });
  return { files, attemptedWrites, attemptedDeletes };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("conversation image upload rollback", () => {
  it("rolls back a failed first write when its resolved target says the origin may have persisted it", async () => {
    const storage = originFilesystem({ failWrite: 1 });
    await expect(uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME, imageFiles: [image("first.png", [1, 2])],
    })).rejects.toThrow(UPLOAD_FAILURE);
    expect(storage.attemptedWrites).toHaveLength(1);
    expect(storage.attemptedDeletes).toEqual(storage.attemptedWrites);
    expect(storage.files).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
    expect(applyChanges.mock.calls[1]?.[0]).toMatchObject({ target: TARGET });
  });

  it("does not issue deletes when preflight fails before a destination or write was reached", async () => {
    const failure = "request origin access token failed (403): access denied";
    applyChanges.mockResolvedValue({ ok: false, error: failure });
    await expect(uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME, imageFiles: [image("first.png", [1, 2])],
    })).rejects.toThrow(failure);
    expect(applyChanges).toHaveBeenCalledOnce();
    expect(applyChanges.mock.calls[0]?.[0].deletes ?? []).toEqual([]);
  });

  it("removes both attempted writes after the second image fails, without reading the third or touching another draft", async () => {
    const storage = originFilesystem({ failWrite: 2 });
    const selected = [image("first.png", [1, 2]), image("second.png", [3, 4]), image("third.png", [5, 6])];
    const originals = [...selected];
    const thirdRead = vi.spyOn(selected[2]!, "arrayBuffer");

    await expect(uploadConversationImageAttachments({ projectId: PROJECT, runtimeId: RUNTIME, imageFiles: selected }))
      .rejects.toThrow(UPLOAD_FAILURE);

    expect(storage.attemptedWrites).toHaveLength(2);
    expect(new Set(storage.attemptedDeletes)).toEqual(new Set(storage.attemptedWrites));
    expect(storage.files).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
    expect(thirdRead).not.toHaveBeenCalled();
    expect(selected).toEqual(originals);
    selected.forEach((file, index) => expect(file).toBe(originals[index]));
  });

  it("rolls back the first image when reading the second file fails and preserves that error", async () => {
    const storage = originFilesystem();
    const unreadable = image("unreadable.png", [3]);
    const readError = new Error("The selected image can no longer be read");
    vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(readError);

    await expect(uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME, imageFiles: [image("first.png", [1, 2]), unreadable],
    })).rejects.toBe(readError);

    expect(storage.attemptedWrites).toHaveLength(1);
    expect(storage.attemptedDeletes).toEqual(storage.attemptedWrites);
    expect(storage.files).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
  });

  it("rolls back a possibly written path when the SDK throws instead of returning a failure", async () => {
    const uploadError = new Error("The upload transport closed after its write");
    const storage = originFilesystem({ failWrite: 2, throwWrite: uploadError });

    await expect(uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME, imageFiles: [image("first.png", [1]), image("second.png", [2])],
    })).rejects.toBe(uploadError);

    expect(storage.attemptedWrites).toHaveLength(2);
    expect(new Set(storage.attemptedDeletes)).toEqual(new Set(storage.attemptedWrites));
    expect(storage.files).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
  });

  it("retains the exact uploaded bytes and returns message attachments without deleting on success", async () => {
    const storage = originFilesystem();
    const attachments = await uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME,
      imageFiles: [image("first.png", [1, 2]), image("second.png", [3, 4, 5])],
    });

    expect(attachments).toHaveLength(2);
    expect(attachments.map(attachment => attachment.fileName)).toEqual(["first.png", "second.png"]);
    expect(storage.files.get(attachments[0]!.workspacePath)).toEqual(new Uint8Array([1, 2]));
    expect(storage.files.get(attachments[1]!.workspacePath)).toEqual(new Uint8Array([3, 4, 5]));
    expect(attachments.map(attachment => attachment.sizeBytes)).toEqual([2, 3]);
    expect(storage.attemptedDeletes).toEqual([]);
    expect(storage.files.size).toBe(3);
    expect(storage.files.get(UNRELATED_PATH)).toEqual(UNRELATED_BYTES);
  });

  it.each([
    ["returns a rejection", "origin apply failed (403): cleanup denied"],
    ["throws", new Error("Cleanup transport closed")],
  ])("reports cleanup failure when deletion %s without replacing the upload error or consuming selected files", async (_label, failDelete) => {
    const storage = originFilesystem({ failWrite: 2, failDelete });
    const selected = [image("first.png", [1, 2]), image("second.png", [3, 4])];
    const originals = [...selected];
    const failure = await uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME, imageFiles: selected,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(UPLOAD_FAILURE);
    expect((failure as Error).message).toMatch(/cleanup|clean up|remov/i);
    expect(storage.attemptedDeletes.length).toBeGreaterThan(0);
    expect(storage.files.get(UNRELATED_PATH)).toEqual(UNRELATED_BYTES);
    expect(selected).toHaveLength(2);
    selected.forEach((file, index) => expect(file).toBe(originals[index]));
  });

  it("a successful retry uses fresh paths and leaves only the returned attachments alongside existing files", async () => {
    const storage = originFilesystem({ failWrite: 2 });
    const selected = [image("first.png", [1, 2]), image("second.png", [3, 4])];
    await expect(uploadConversationImageAttachments({ projectId: PROJECT, runtimeId: RUNTIME, imageFiles: selected }))
      .rejects.toThrow(UPLOAD_FAILURE);
    const failedPaths = [...storage.attemptedWrites];

    const attachments = await uploadConversationImageAttachments({ projectId: PROJECT, runtimeId: RUNTIME, imageFiles: selected });

    expect(attachments).toHaveLength(2);
    for (const path of failedPaths) {
      expect(storage.files.has(path)).toBe(false);
      expect(attachments.some(attachment => attachment.workspacePath === path)).toBe(false);
    }
    expect(new Set(storage.files.keys())).toEqual(new Set([UNRELATED_PATH, ...attachments.map(attachment => attachment.workspacePath)]));
    expect(storage.files.get(attachments[0]!.workspacePath)).toEqual(new Uint8Array([1, 2]));
    expect(storage.files.get(attachments[1]!.workspacePath)).toEqual(new Uint8Array([3, 4]));
  });

  it("retries cleanup while the origin finishes the preceding write", async () => {
    vi.useFakeTimers();
    const storage = originFilesystem({ failWrite: 2 });
    const apply = applyChanges.getMockImplementation()!;
    let busy = true;
    applyChanges.mockImplementation(async (params: OriginApplyOptions) => {
      if (params.deletes?.length && busy) {
        busy = false;
        return { ok: false, error: "origin apply failed (409): workspace is already applying changes", target: TARGET };
      }
      return apply(params);
    });
    const pending = uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME,
      imageFiles: [image("first.png", [1]), image("second.png", [2])],
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ message: UPLOAD_FAILURE });
    expect(storage.files).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
    expect(applyChanges.mock.calls.filter(([params]) => params.deletes?.length)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops cleanup retries at their deadline and reports leftover files", async () => {
    vi.useFakeTimers();
    const storage = originFilesystem({ failWrite: 2, failDelete: "origin apply failed (503): unavailable" });
    const pending = uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME,
      imageFiles: [image("first.png", [1]), image("second.png", [2])],
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ message: expect.stringContaining("Cleanup could not finish") });
    expect(storage.files.size).toBe(3);
    const callsAtDeadline = applyChanges.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applyChanges.mock.calls).toHaveLength(callsAtDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["the first upload needs a retry", 1],
    ["a later upload needs a retry", 2],
  ])("pins retries, subsequent images and rollback to the resolved origin and auth context when %s", async (_label, retryByte) => {
    vi.useFakeTimers();
    const replacementTarget: ApplyTarget = {
      projectId: PROJECT,
      originId: "replacement-origin",
      runtimeId: "replacement-runtime",
      requestContext: {
        baseUrl: "https://controller-b.invalid",
        accessToken: "inert-upload-test-token-b",
        credentialSource: "fixed",
        generation: 8,
      },
    };
    let currentDefault = TARGET;
    const originalFiles = new Map<string, Uint8Array>([[UNRELATED_PATH, UNRELATED_BYTES]]);
    const replacementFiles = new Map<string, Uint8Array>([[UNRELATED_PATH, UNRELATED_BYTES]]);
    const attemptsByPath = new Map<string, number>();
    const calls: PinnedApplyOptions[] = [];
    applyChanges.mockImplementation(async (params: PinnedApplyOptions) => {
      calls.push(params);
      const target = params.target ?? currentDefault;
      const files = target.originId === ORIGIN ? originalFiles : replacementFiles;
      // Simulate a user/controller/default-origin change immediately after
      // resolution. A new implicit resolution would now use a different scope.
      currentDefault = replacementTarget;
      for (const file of params.files) {
        const bytes = new Uint8Array(file.bytes ?? []);
        const attempt = (attemptsByPath.get(file.path) ?? 0) + 1;
        attemptsByPath.set(file.path, attempt);
        files.set(file.path, bytes);
        if (bytes[0] === retryByte && attempt === 1) {
          return { ok: false, error: "origin apply failed (503): try again", target };
        }
        if (bytes[0] === 3) return { ok: false, error: UPLOAD_FAILURE, target };
      }
      for (const path of params.deletes ?? []) files.delete(path);
      return { ok: true, target };
    });
    const pending = uploadConversationImageAttachments({
      projectId: PROJECT, runtimeId: RUNTIME,
      imageFiles: [image("first.png", [1]), image("second.png", [2]), image("third.png", [3])],
    }).then(() => null, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ message: UPLOAD_FAILURE });

    expect(calls.filter(call => call.files.length > 0)).toHaveLength(4);
    expect(calls[0]!.target).toBeUndefined();
    for (const call of calls.slice(1)) {
      expect(call.target).toEqual(TARGET);
      expect(call.projectId).toBe(PROJECT);
    }
    expect(calls.some(call => (call.deletes?.length ?? 0) > 0)).toBe(true);
    expect(originalFiles).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
    expect(replacementFiles).toEqual(new Map([[UNRELATED_PATH, UNRELATED_BYTES]]));
    expect(vi.getTimerCount()).toBe(0);
  });
});
