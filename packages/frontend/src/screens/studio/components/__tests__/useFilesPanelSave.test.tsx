// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFile } from "../../../../types";
import type { VersioningMode } from "../../../../sdk/instafy";
import { useWorkspaceStore } from "../../../../store";
import { createOwnRevisions } from "../filesVersioning";
import { SAVE_RETRY_LATER_CAP_MS, useFilesPanelSave, type UseFilesPanelSaveOptions } from "../useFilesPanelSave";

const mocks = vi.hoisted(() => ({ saveChanges: vi.fn(), readAt: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { files: { readAt: mocks.readAt }, save: { changes: mocks.saveChanges } } },
}));

const REV_1 = "1".repeat(40);

// A 503 that says to try again later. On /apply the save cannot tell whether
// the change landed (usually it did not), so `applied` stays false.
const answered = (code: string, retryAfterMs?: number, patch: Record<string, unknown> = {}) => ({
  ok: false,
  stage: "apply",
  originId: "origin-1",
  originMode: "hosted",
  applied: false,
  appliedRev: null,
  error: { status: 503, code, message: "try again in a moment", routeUnavailable: false, retryAfterMs },
  ...patch,
});
const fetchPending = (retryAfterMs?: number) => answered("fetch_pending", retryAfterMs);

const savedResult = {
  ok: true, originId: "origin-1", originMode: "hosted", rev: "2".repeat(40), baseRev: REV_1, committed: true,
  saved: ["README.md"], conflicted: [], rejected: [], recoveryRef: null, via: "apply", report: null,
};

describe("useFilesPanelSave retry after an answer that says to try again later", () => {
  let root: Root;
  let container: HTMLDivElement;
  let save: () => Promise<void>;
  const wait = vi.fn(async () => undefined);
  const presentFailure = vi.fn<UseFilesPanelSaveOptions["presentFailure"]>();
  const updateWorkspace = vi.fn();
  let mode: VersioningMode = "stateless";
  const file: CodeFile = {
    id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "edited",
    baseRev: REV_1, blobOid: "a".repeat(40), originId: "origin-1",
  };

  function Harness() {
    const options: UseFilesPanelSaveOptions = {
      enabled: true,
      versioning: { mode, originId: "origin-1" },
      activeProjectId: "space-a",
      readOnly: false,
      originAvailable: true,
      getActiveFile: () => file,
      getFile: () => file,
      getPendingContent: (buffer) => buffer.modified,
      updateWorkspace,
      directoryRevsRef: { current: { "": REV_1 } },
      keepFoldersRef: { current: new Set() },
      loadDirectory: vi.fn(async () => []),
      ownRevisions: createOwnRevisions(),
      presentFailure,
      wait,
    };
    save = useFilesPanelSave(options).save;
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mode = "stateless";
    // Answers queued by a test that failed early never leak into the next.
    mocks.saveChanges.mockReset();
    mocks.readAt.mockReset();
    // The space whose buffers the code store holds (the save's own space).
    useWorkspaceStore.setState({ activeProjectId: "space-a" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("waits at most the cap before its one retry", async () => {
    mocks.saveChanges.mockResolvedValue(fetchPending(30_000));
    await act(async () => save());
    expect(wait).toHaveBeenCalledExactlyOnceWith(SAVE_RETRY_LATER_CAP_MS);
    expect(SAVE_RETRY_LATER_CAP_MS).toBe(5_000);
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(presentFailure).toHaveBeenCalledExactlyOnceWith(
      { message: "The space is still loading. Try again in a moment." },
      expect.any(Function),
    );
  });

  it("follows a shorter Retry-After and waits a second without one", async () => {
    mocks.saveChanges.mockResolvedValue(fetchPending(250));
    await act(async () => save());
    expect(wait).toHaveBeenLastCalledWith(250);
    mocks.saveChanges.mockResolvedValue(fetchPending(undefined));
    await act(async () => save());
    expect(wait).toHaveBeenLastCalledWith(1_000);
    expect(mocks.saveChanges).toHaveBeenCalledTimes(4);
  });

  it.each(["writes_busy", "mirror_reset"])("tries %s once more after Retry-After, within the same cap", async (code) => {
    mocks.saveChanges.mockResolvedValueOnce(answered(code, 2_000)).mockResolvedValueOnce(savedResult);
    await act(async () => save());
    expect(wait).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(mocks.saveChanges.mock.calls[1][0]).toEqual(mocks.saveChanges.mock.calls[0][0]);
    expect(presentFailure).not.toHaveBeenCalled();
    // The saved buffer is recorded once, from the retry's answer.
    expect(updateWorkspace).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.saveChanges.mockResolvedValueOnce(answered(code, 30_000)).mockResolvedValueOnce(savedResult);
    await act(async () => save());
    expect(wait).toHaveBeenCalledExactlyOnceWith(SAVE_RETRY_LATER_CAP_MS);
    mocks.saveChanges.mockResolvedValueOnce(answered(code)).mockResolvedValueOnce(savedResult);
    await act(async () => save());
    expect(wait).toHaveBeenLastCalledWith(1_000);
  });

  it.each([
    ["writes_busy", "The server is busy saving other changes. Your edits are kept here. Try again in a moment."],
    ["mirror_reset", "The server is rebuilding its copy of this space. Your edits are kept here. Try again in a moment."],
    // A retry can meet a fetch the copy made again started.
    ["fetch_pending", "The space is still loading. Try again in a moment."],
  ])("asks only once, then keeps the edits after a second answer of %s", async (code, message) => {
    mocks.saveChanges.mockResolvedValueOnce(answered("mirror_reset", 0)).mockResolvedValueOnce(answered(code, 0));
    await act(async () => save());
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(presentFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }), expect.any(Function));
    // Nothing was saved: the buffer is left as it is, edits included.
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("never asks again on its own when the space is out of room", async () => {
    mocks.saveChanges.mockResolvedValue(answered("disk_full", 2_000));
    await act(async () => save());
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(presentFailure).toHaveBeenCalledExactlyOnceWith(
      { message: "The space is out of room right now. Your edits are kept here. Try again later." },
      expect.any(Function),
    );
    expect(updateWorkspace).not.toHaveBeenCalled();
    // Trying again is the person's call. The save hashes the bytes with
    // WebCrypto before it sends, which settles on a later task (later still
    // on a loaded machine), so this awaits the save the retry starts rather
    // than a timer tick.
    mocks.saveChanges.mockResolvedValueOnce(savedResult);
    await act(async () => presentFailure.mock.calls[0][1]());
    expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
    // The retry's answer is recorded once.
    expect(updateWorkspace).toHaveBeenCalledTimes(1);
  });

  // The apply landed (here a no-op: the space already held these bytes) and
  // the sync's fetch of main met a slow or damaged copy. On the stateless
  // gateway a replay is safe: the same change on a main that already holds
  // it is answered committed:false and writes nothing.
  it.each(["fetch_pending", "mirror_reset"])(
    "asks once more when the sync after an apply that landed answers %s",
    async (code) => {
      mocks.saveChanges
        .mockResolvedValueOnce(answered(code, 2_000, { stage: "sync", applied: true, appliedRev: REV_1 }))
        .mockResolvedValueOnce({ ...savedResult, rev: REV_1, committed: false, via: "sync" });
      await act(async () => save());
      expect(wait).toHaveBeenCalledExactlyOnceWith(2_000);
      expect(mocks.saveChanges).toHaveBeenCalledTimes(2);
      expect(mocks.saveChanges.mock.calls[1][0]).toEqual(mocks.saveChanges.mock.calls[0][0]);
      expect(presentFailure).not.toHaveBeenCalled();
      // The buffer is recorded as saved once, from the retry's answer.
      expect(updateWorkspace).toHaveBeenCalledTimes(1);
    },
  );

  // A Desktop folder publishes with /git/sync, and a replay with the same
  // `expected` would meet the bytes the first apply wrote.
  it("never replays an apply that landed in a Desktop folder", async () => {
    mode = "desktop";
    await act(async () => root.render(<Harness />));
    mocks.saveChanges.mockResolvedValue(
      answered("fetch_pending", 0, { stage: "sync", applied: true, appliedRev: null, originMode: "desktop" }),
    );
    await act(async () => save());
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(presentFailure).toHaveBeenCalledExactlyOnceWith(
      { message: "The space is still loading. Try again in a moment." },
      expect.any(Function),
    );
  });
});
