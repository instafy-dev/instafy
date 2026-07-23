import { describe, expect, it } from "vitest";

import {
  normalizeInlineCompletionPath,
  shouldRequestInlineCompletion,
  sliceEditorInlineCompletionContext,
} from "../editorInlineCompletions";

describe("editorInlineCompletions", () => {
  it("normalizes controller file paths", () => {
    expect(normalizeInlineCompletionPath("\\src\\App.tsx")).toBe("src/App.tsx");
    expect(normalizeInlineCompletionPath("/README.md")).toBe("README.md");
  });

  it("clamps completion context around the cursor and normalizes newlines", () => {
    const prefix = "a".repeat(6100);
    const suffix = "b".repeat(2200);
    const documentText = `${prefix}\r\n${suffix}`;
    const context = sliceEditorInlineCompletionContext(documentText, 6101);

    expect(context.prefix).toHaveLength(6000);
    expect(context.suffix).toHaveLength(2000);
    expect(context.prefix.includes("\r")).toBe(false);
    expect(context.suffix.includes("\r")).toBe(false);
  });

  it("only requests proxy completions when there is visible context", () => {
    expect(
      shouldRequestInlineCompletion({
        projectId: "project-1",
        path: "src/App.tsx",
        prefix: "const conver",
        suffix: "",
      }),
    ).toBe(true);

    expect(
      shouldRequestInlineCompletion({
        projectId: "project-1",
        path: "README.md",
        prefix: "   \n",
        suffix: "\t",
      }),
    ).toBe(false);
  });
});
