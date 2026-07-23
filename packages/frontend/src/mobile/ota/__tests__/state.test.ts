import { describe, expect, it } from "vitest";
import { reconcileNativeOtaState } from "../state";

describe("reconcileNativeOtaState", () => {
  it("promotes an applied pending bundle into current state", () => {
    const result = reconcileNativeOtaState({
      state: {
        current: {
          bundle_version: "app-build-1",
          git_sha: "git-app-build-1",
        },
        pending: {
          release_id: "release-2",
          bundle_version: "bundle-2",
          git_sha: "git-bundle-2",
        },
      },
      current_bundle_id: "bundle-2",
      previous_bundle_id: "app-build-1",
      rollback: false,
    });

    expect(result.applied_pending).toEqual({
      release_id: "release-2",
      bundle_version: "bundle-2",
      git_sha: "git-bundle-2",
    });
    expect(result.rolled_back_pending).toBeNull();
    expect(result.state.current).toEqual({
      bundle_version: "bundle-2",
      git_sha: "git-bundle-2",
    });
    expect(result.state.pending).toEqual({
      release_id: null,
      bundle_version: null,
      git_sha: null,
    });
  });

  it("clears pending state when a rollback is reported", () => {
    const result = reconcileNativeOtaState({
      state: {
        current: {
          bundle_version: "bundle-2",
          git_sha: "git-bundle-2",
        },
        pending: {
          release_id: "release-3",
          bundle_version: "bundle-3",
          git_sha: "git-bundle-3",
        },
      },
      current_bundle_id: null,
      previous_bundle_id: "bundle-3",
      rollback: true,
    });

    expect(result.applied_pending).toBeNull();
    expect(result.rolled_back_pending).toEqual({
      release_id: "release-3",
      bundle_version: "bundle-3",
      git_sha: "git-bundle-3",
    });
    expect(result.state.pending).toEqual({
      release_id: null,
      bundle_version: null,
      git_sha: null,
    });
    expect(result.state.current.bundle_version).toBeTruthy();
  });

  it("retains an unknown live bundle id while clearing git sha until metadata is known", () => {
    const result = reconcileNativeOtaState({
      state: {
        current: {
          bundle_version: "app-build-1",
          git_sha: "git-app-build-1",
        },
        pending: {
          release_id: null,
          bundle_version: null,
          git_sha: null,
        },
      },
      current_bundle_id: "bundle-unknown",
      previous_bundle_id: "app-build-1",
      rollback: false,
    });

    expect(result.state.current).toEqual({
      bundle_version: "bundle-unknown",
      git_sha: null,
    });
  });
});
