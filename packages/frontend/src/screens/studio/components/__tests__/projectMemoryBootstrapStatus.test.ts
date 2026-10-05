import { describe, expect, it } from "vitest";

import type { ControllerProjectMemoryBootstrapResult } from "../../../../services/runtimeController/projects";
import { describeProjectMemoryBootstrapResult } from "../projectMemoryBootstrapStatus";

function result(
  overrides: Partial<ControllerProjectMemoryBootstrapResult>,
): ControllerProjectMemoryBootstrapResult {
  return { ok: true, seeded: false, fileCount: 0, rev: null, reason: null, ...overrides };
}

describe("describeProjectMemoryBootstrapResult", () => {
  it("treats a conflict as a completed outcome with neutral copy", () => {
    for (const action of ["refresh-defaults", "install-default-skills"] as const) {
      const status = describeProjectMemoryBootstrapResult(result({ reason: "conflict" }), action);
      expect(status).not.toBeNull();
      expect(status?.intent).toBe("info");
      expect(status?.committed).toBe(false);
      expect(status?.message).toMatch(/left as they are because they changed in the meantime\.$/);
      expect(status?.message).not.toContain("—");
      expect(status?.message).not.toBe("conflict");
    }
    expect(
      describeProjectMemoryBootstrapResult(result({ reason: "conflict" }), "refresh-defaults")?.message,
    ).toBe("Some default files were left as they are because they changed in the meantime.");
  });

  it("keeps the existing outcomes", () => {
    expect(
      describeProjectMemoryBootstrapResult(result({ seeded: true, fileCount: 2 }), "refresh-defaults"),
    ).toEqual({ message: "Defaults refreshed (2 files).", intent: "success", duration: 3500, committed: true });
    expect(
      describeProjectMemoryBootstrapResult(result({ seeded: true, fileCount: 1 }), "install-default-skills"),
    ).toEqual({ message: "Installed 1 default skill.", intent: "success", duration: 3000, committed: true });
    expect(
      describeProjectMemoryBootstrapResult(result({ reason: "already-present" }), "refresh-defaults")?.message,
    ).toBe("No default files changed.");
    expect(
      describeProjectMemoryBootstrapResult(result({ reason: "already-present" }), "install-default-skills")
        ?.message,
    ).toBe("Default skills are already installed.");
    expect(
      describeProjectMemoryBootstrapResult(result({ reason: "workspace-busy" }), "install-default-skills")
        ?.intent,
    ).toBe("warning");
    expect(
      describeProjectMemoryBootstrapResult(result({ reason: "no-origin" }), "refresh-defaults")?.intent,
    ).toBe("warning");
  });

  it("leaves unknown reasons to the caller's error path", () => {
    expect(
      describeProjectMemoryBootstrapResult(result({ ok: false, reason: "origin apply failed" }), "refresh-defaults"),
    ).toBeNull();
    expect(
      describeProjectMemoryBootstrapResult(result({ reason: "no-origin" }), "install-default-skills"),
    ).toBeNull();
  });
});
