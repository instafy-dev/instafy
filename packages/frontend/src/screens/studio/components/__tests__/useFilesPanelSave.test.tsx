// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFile } from "../../../../types";
import { useWorkspaceStore } from "../../../../store";
import { createOwnRevisions } from "../filesVersioning";
import { SAVE_FETCH_PENDING_RETRY_CAP_MS, useFilesPanelSave, type UseFilesPanelSaveOptions } from "../useFilesPanelSave";

const mocks = vi.hoisted(() => ({ saveChanges: vi.fn(), readAt: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { files: { readAt: mocks.readAt }, save: { changes: mocks.saveChanges } } },
}));

const REV_1 = "1".repeat(40);

const fetchPending = (retryAfterMs?: number) => ({
  ok: false,
  stage: "apply",
  originId: "origin-1",
  originMode: "hosted",
  applied: false,
  appliedRev: null,
  error: { status: 503, code: "fetch_pending", message: "loading", routeUnavailable: false, retryAfterMs },
});

describe("useFilesPanelSave fetch_pending retry", () => {
  let root: Root;
  let container: HTMLDivElement;
  let save: () => Promise<void>;
  const wait = vi.fn(async () => undefined);
  const presentFailure = vi.fn();
  const file: CodeFile = {
    id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "edited",
    baseRev: REV_1, blobOid: "a".repeat(40), originId: "origin-1",
  };

  function Harness() {
    const options: UseFilesPanelSaveOptions = {
      enabled: true,
      versioning: { mode: "stateless", originId: "origin-1" },
      activeProjectId: "space-a",
      readOnly: false,
      originAvailable: true,
      getActiveFile: () => file,
      getFile: () => file,
      getPendingContent: (buffer) => buffer.modified,
      updateWorkspace: vi.fn(),
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
    expect(wait).toHaveBeenCalledExactlyOnceWith(SAVE_FETCH_PENDING_RETRY_CAP_MS);
    expect(SAVE_FETCH_PENDING_RETRY_CAP_MS).toBe(5_000);
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
});
