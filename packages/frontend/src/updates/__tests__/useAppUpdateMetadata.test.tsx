// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_UPDATER_STATUS_CHANGED_EVENT } from "../../desktop/updates/state";
import type { AppReleaseMetadata } from "../releaseMetadata";

const { collectAppReleaseMetadataMock } = vi.hoisted(() => ({
  collectAppReleaseMetadataMock: vi.fn(),
}));

vi.mock("../releaseMetadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../releaseMetadata")>();
  return {
    ...actual,
    collectAppReleaseMetadata: collectAppReleaseMetadataMock,
  };
});

import { useAppUpdateMetadata } from "../useAppUpdateMetadata";

function metadata(phase: string): AppReleaseMetadata {
  return {
    build: {
      app: "instafy-frontend",
      packageVersion: "1.2.3",
      gitCommit: "abcdef1234567890",
      gitCommitShort: "abcdef12",
      gitBranch: "main",
      builtAt: "2026-07-21T12:00:00.000Z",
      releaseId: "release-123",
    },
    runtime_surface: "desktop",
    binary: {
      version: "1.2.3",
      label: "v1.2.3 (abcdef12)",
      platform: "desktop-web",
    },
    updates: {
      supported: true,
      is_enabled: true,
      primary_action: phase === "downloaded" ? "install" : "download",
      channel: "stable",
      phase,
      current_bundle_version: null,
      current_git_sha: null,
      available_version: "1.2.4",
      native_version: "1.2.3",
      feed_url: "https://downloads.instafy.dev/desktop-app/stable",
      last_checked_at: "2026-07-21T12:00:00.000Z",
      last_downloaded_at: phase === "downloaded" ? "2026-07-21T12:01:00.000Z" : null,
      last_error: null,
      last_check_reason: null,
    },
  };
}

function Harness() {
  const { metadata: updateMetadata } = useAppUpdateMetadata(true);
  return <span data-testid="phase">{updateMetadata?.updates.phase ?? "none"}</span>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("useAppUpdateMetadata", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    collectAppReleaseMetadataMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("refreshes mounted metadata on poll events even when no update menu is open", async () => {
    collectAppReleaseMetadataMock.mockResolvedValueOnce(metadata("update_available"));

    await act(async () => root.render(<Harness />));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="phase"]')?.textContent).toBe(
        "update_available",
      );
    });

    collectAppReleaseMetadataMock.mockResolvedValueOnce(metadata("downloaded"));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DESKTOP_UPDATER_STATUS_CHANGED_EVENT));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="phase"]')?.textContent).toBe(
        "downloaded",
      );
    });
  });

  it("does not let an older refresh overwrite a newer updater state", async () => {
    const older = deferred<AppReleaseMetadata>();
    const newer = deferred<AppReleaseMetadata>();
    collectAppReleaseMetadataMock
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    await act(async () => root.render(<Harness />));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DESKTOP_UPDATER_STATUS_CHANGED_EVENT));
    });

    await act(async () => {
      newer.resolve(metadata("downloaded"));
      await newer.promise;
    });
    expect(container.querySelector('[data-testid="phase"]')?.textContent).toBe(
      "downloaded",
    );

    await act(async () => {
      older.resolve(metadata("update_available"));
      await older.promise;
    });
    expect(container.querySelector('[data-testid="phase"]')?.textContent).toBe(
      "downloaded",
    );
  });
});
