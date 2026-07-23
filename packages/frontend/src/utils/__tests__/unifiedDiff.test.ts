import { describe, expect, it } from "vitest";
import { buildSplitDiffRows, parseUnifiedDiff } from "../unifiedDiff";

describe("buildSplitDiffRows", () => {
  it("pairs deletions and additions from the same hunk into split rows", () => {
    const diff = [
      "@@ -1,4 +1,4 @@",
      " line one",
      "-old two",
      "-old three",
      "+new two",
      "+new three",
      " line four",
    ].join("\n");

    const rows = buildSplitDiffRows(parseUnifiedDiff(diff));

    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -1,4 +1,4 @@" },
      {
        kind: "line",
        left: { kind: "context", lineNumber: 1, text: "line one" },
        right: { kind: "context", lineNumber: 1, text: "line one" },
      },
      {
        kind: "line",
        left: { kind: "del", lineNumber: 2, text: "old two" },
        right: { kind: "add", lineNumber: 2, text: "new two" },
      },
      {
        kind: "line",
        left: { kind: "del", lineNumber: 3, text: "old three" },
        right: { kind: "add", lineNumber: 3, text: "new three" },
      },
      {
        kind: "line",
        left: { kind: "context", lineNumber: 4, text: "line four" },
        right: { kind: "context", lineNumber: 4, text: "line four" },
      },
    ]);
  });

  it("keeps unmatched deletions or additions on their own side", () => {
    const diff = [
      "@@ -4,3 +4,4 @@",
      "-removed only",
      " context",
      "+added one",
      "+added two",
    ].join("\n");

    const rows = buildSplitDiffRows(parseUnifiedDiff(diff));

    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -4,3 +4,4 @@" },
      {
        kind: "line",
        left: { kind: "del", lineNumber: 4, text: "removed only" },
        right: null,
      },
      {
        kind: "line",
        left: { kind: "context", lineNumber: 5, text: "context" },
        right: { kind: "context", lineNumber: 4, text: "context" },
      },
      {
        kind: "line",
        left: null,
        right: { kind: "add", lineNumber: 5, text: "added one" },
      },
      {
        kind: "line",
        left: null,
        right: { kind: "add", lineNumber: 6, text: "added two" },
      },
    ]);
  });
});
