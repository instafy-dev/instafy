import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  authListener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
vi.mock("../chatAttachments", () => ({ downloadChatAttachment: mocks.download }));
vi.mock("../supabaseClient", () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: {
      onAuthStateChange: (listener: typeof mocks.authListener) => {
        mocks.authListener = listener;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
}));

import {
  CHAT_ATTACHMENT_PREVIEW_CONCURRENCY,
  clearChatAttachmentPreviews,
  loadChatAttachmentPreview,
  seedChatAttachmentPreview,
} from "../chatAttachmentPreviews";

const PREFIX = "11111111-2222-4333-8444-555555555555/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pathFor = (index: number) => `${PREFIX}/0f0f0f0f-1111-4222-8333-${String(index).padStart(12, "0")}.png`;

function deferredDownloads() {
  const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
  mocks.download.mockImplementation(
    (path: string) => new Promise((resolve) => pending.push({ path, resolve })),
  );
  return pending;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("chat attachment previews", () => {
  beforeEach(() => {
    mocks.download.mockReset();
    clearChatAttachmentPreviews();
  });

  it(`runs at most ${CHAT_ATTACHMENT_PREVIEW_CONCURRENCY} downloads at once and starts the rest in turn`, async () => {
    const pending = deferredDownloads();
    const loads = Array.from({ length: 6 }, (_, index) => loadChatAttachmentPreview(pathFor(index)));
    await flush();
    expect(pending.map((entry) => entry.path)).toEqual([0, 1, 2, 3].map(pathFor));

    pending[0].resolve({ ok: true, blob: new Blob(["0"]) });
    await flush();
    expect(pending).toHaveLength(5);
    expect(pending[4].path).toBe(pathFor(4));

    for (const entry of pending.slice(1)) entry.resolve({ ok: true, blob: new Blob(["x"]) });
    await flush();
    pending[5]?.resolve({ ok: true, blob: new Blob(["x"]) });
    await expect(Promise.all(loads)).resolves.toHaveLength(6);
    expect(pending).toHaveLength(6);
  });

  it("shares one download per name and keeps the bytes, but never a failure", async () => {
    const blob = new Blob(["png"]);
    mocks.download
      .mockResolvedValueOnce({ ok: false, reason: "transient" })
      .mockResolvedValueOnce({ ok: true, blob });

    await expect(loadChatAttachmentPreview(pathFor(1))).resolves.toEqual({ ok: false, reason: "transient" });
    const [first, second] = await Promise.all([
      loadChatAttachmentPreview(pathFor(1)),
      loadChatAttachmentPreview(pathFor(1)),
    ]);
    expect(first).toEqual({ ok: true, blob });
    expect(second).toEqual({ ok: true, blob });
    await expect(loadChatAttachmentPreview(pathFor(1))).resolves.toEqual({ ok: true, blob });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it("keeps only the most recent previews", async () => {
    mocks.download.mockImplementation(async () => ({ ok: true, blob: new Blob(["x"]) }));
    for (let index = 0; index < 41; index += 1) {
      seedChatAttachmentPreview(pathFor(index), new Blob([String(index)]));
    }
    // The oldest of 41 was dropped; the newest is still kept.
    await loadChatAttachmentPreview(pathFor(40));
    expect(mocks.download).not.toHaveBeenCalled();
    await loadChatAttachmentPreview(pathFor(0));
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(pathFor(0));

    // A large preview pushes older ones out to stay under the byte budget.
    clearChatAttachmentPreviews();
    mocks.download.mockClear();
    seedChatAttachmentPreview(pathFor(1), new Blob([new Uint8Array(40 * 1024 * 1024)]));
    seedChatAttachmentPreview(pathFor(2), new Blob([new Uint8Array(30 * 1024 * 1024)]));
    await loadChatAttachmentPreview(pathFor(2));
    await loadChatAttachmentPreview(pathFor(1));
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(pathFor(1));
  });

  it("drops everything when the signed-in person changes, in-flight downloads included", async () => {
    seedChatAttachmentPreview(pathFor(1), new Blob(["mine"]));
    mocks.authListener?.("INITIAL_SESSION", { user: { id: "user-a" } });
    mocks.authListener?.("TOKEN_REFRESHED", { user: { id: "user-a" } });
    await loadChatAttachmentPreview(pathFor(1));
    expect(mocks.download).not.toHaveBeenCalled();

    const pending = deferredDownloads();
    const started = loadChatAttachmentPreview(pathFor(2));
    await flush();
    mocks.authListener?.("SIGNED_OUT", null);
    pending[0].resolve({ ok: true, blob: new Blob(["a's"]) });
    await started;

    mocks.download.mockReset().mockResolvedValue({ ok: false, reason: "refused" });
    // The next person's session decides again for both names.
    await expect(loadChatAttachmentPreview(pathFor(1))).resolves.toEqual({ ok: false, reason: "refused" });
    await expect(loadChatAttachmentPreview(pathFor(2))).resolves.toEqual({ ok: false, reason: "refused" });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });
});
