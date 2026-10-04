import { describe, expect, it } from "vitest";
import type { CodeFile, CodeWorkspace } from "../../types";
import { createDefaultCodeWorkspace } from "../defaults";
import { keepSavedVersionIds } from "../savedVersionIds";

const workspace = (files: CodeFile[]): CodeWorkspace => ({ ...createDefaultCodeWorkspace(), files, activeFileId: null });
const file = (patch: Partial<CodeFile>): CodeFile => ({ id: "a.md", path: "a.md", label: "a.md", generated: "", modified: "", ...patch });

describe("keepSavedVersionIds", () => {
  it("restores the edited text but keeps a versioned buffer's base and read ids", () => {
    const before = workspace([file({ generated: "v1", modified: "typing", baseRev: "r1", blobOid: "b1", originId: "o", isNew: true })]);
    const after = workspace([file({ generated: "v2", modified: "v2", baseRev: "r2", blobOid: "b2", originId: "o", readAt: 5 })]);
    const restored = keepSavedVersionIds(before, after).files[0];
    expect(restored).toMatchObject({ generated: "v2", modified: "typing", baseRev: "r2", blobOid: "b2", originId: "o", readAt: 5 });
    expect(restored.isNew).toBeUndefined();
  });

  it("restores legacy buffers exactly as before", () => {
    const before = workspace([file({ generated: "v1", modified: "typing" })]);
    const after = workspace([file({ generated: "v2", modified: "v2" })]);
    expect(keepSavedVersionIds(before, after)).toBe(before);
  });

  it("leaves files the current workspace no longer has", () => {
    const before = workspace([file({ id: "gone.md", path: "gone.md", generated: "x", originId: "o" })]);
    expect(keepSavedVersionIds(before, workspace([]))).toBe(before);
  });
});
