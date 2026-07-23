import { describe, expect, it } from "vitest";
import type { ViewerState } from "../useFilesPanelViewerState";
import { resolveViewerStateWithoutActiveFile } from "../filesPanelViewerSync";

const previewEntry = {
  name: "preview.svg",
  path: "preview.svg",
  kind: "file" as const,
};

describe("resolveViewerStateWithoutActiveFile", () => {
  it("clears a stale text viewer after its active file is removed", () => {
    expect(
      resolveViewerStateWithoutActiveFile({
        mode: "text",
        entry: previewEntry,
        error: null,
      }),
    ).toEqual({ mode: "idle", entry: null, error: null });
  });

  it.each<ViewerState>([
    { mode: "idle", entry: null, error: null },
    { mode: "loading", entry: previewEntry, error: null },
    { mode: "image", entry: previewEntry, imageUrl: "/preview.svg", error: null },
    {
      mode: "unsupported",
      entry: previewEntry,
      rawUrl: "/preview.bin",
      error: "Unsupported",
    },
    { mode: "directory", entry: { ...previewEntry, kind: "directory" }, error: null },
    { mode: "error", entry: previewEntry, error: "Unable to load preview" },
  ])("preserves an intentional $mode viewer without a code-editor active file", (state) => {
    expect(resolveViewerStateWithoutActiveFile(state)).toBe(state);
  });
});
