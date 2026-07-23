export type DiffRowKind = "meta" | "hunk" | "context" | "add" | "del";

export type DiffRow = {
  kind: DiffRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type SplitDiffCellKind = "context" | "add" | "del";

export type SplitDiffCell = {
  kind: SplitDiffCellKind;
  lineNumber: number | null;
  text: string;
};

export type SplitDiffRow =
  | {
      kind: "hunk";
      text: string;
    }
  | {
      kind: "meta";
      text: string;
    }
  | {
      kind: "line";
      left: SplitDiffCell | null;
      right: SplitDiffCell | null;
    };

function isDiffMetaLine(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("copy from") ||
    line.startsWith("copy to") ||
    line.startsWith("Binary files") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("\\ No newline")
  );
}

export function parseUnifiedDiff(diff: string): DiffRow[] {
  const lines = diff.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const rows: DiffRow[] = [];
  let inHunk = false;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      oldLine = null;
      newLine = null;
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (line.startsWith("@@")) {
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      oldLine = match ? Number.parseInt(match[1] ?? "0", 10) : null;
      newLine = match ? Number.parseInt(match[2] ?? "0", 10) : null;
      inHunk = true;
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (isDiffMetaLine(line)) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (!inHunk) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }

    const prefix = line[0] ?? "";
    if (prefix === "+" && !line.startsWith("+++")) {
      const currentNewLine = typeof newLine === "number" ? newLine : null;
      rows.push({ kind: "add", oldLine: null, newLine: currentNewLine, text: line });
      if (typeof newLine === "number") {
        newLine += 1;
      }
      continue;
    }

    if (prefix === "-" && !line.startsWith("---")) {
      const currentOldLine = typeof oldLine === "number" ? oldLine : null;
      rows.push({ kind: "del", oldLine: currentOldLine, newLine: null, text: line });
      if (typeof oldLine === "number") {
        oldLine += 1;
      }
      continue;
    }

    if (prefix === " ") {
      const currentOldLine = typeof oldLine === "number" ? oldLine : null;
      const currentNewLine = typeof newLine === "number" ? newLine : null;
      rows.push({ kind: "context", oldLine: currentOldLine, newLine: currentNewLine, text: line });
      if (typeof oldLine === "number") {
        oldLine += 1;
      }
      if (typeof newLine === "number") {
        newLine += 1;
      }
      continue;
    }

    rows.push({ kind: "context", oldLine: null, newLine: null, text: line });
  }

  return rows;
}

export function splitUnifiedDiffHeader(diff: string): { headerLines: string[]; bodyDiff: string } {
  const lines = diff.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunkIndex === -1) {
    return { headerLines: lines, bodyDiff: "" };
  }
  return {
    headerLines: lines.slice(0, firstHunkIndex),
    bodyDiff: lines.slice(firstHunkIndex).join("\n"),
  };
}

function stripUnifiedPrefix(row: DiffRow): string {
  if ((row.kind === "context" || row.kind === "add" || row.kind === "del") && row.text.length > 0) {
    return row.text.slice(1);
  }
  return row.text;
}

function toSplitCell(row: DiffRow, side: "left" | "right"): SplitDiffCell {
  const kind: SplitDiffCellKind = row.kind === "add" ? "add" : row.kind === "del" ? "del" : "context";
  return {
    kind,
    lineNumber: side === "left" ? row.oldLine : row.newLine,
    text: stripUnifiedPrefix(row),
  };
}

export function buildSplitDiffRows(rows: DiffRow[]): SplitDiffRow[] {
  const splitRows: SplitDiffRow[] = [];
  let pendingDeleted: DiffRow[] = [];
  let pendingAdded: DiffRow[] = [];

  const flushPending = () => {
    const maxLength = Math.max(pendingDeleted.length, pendingAdded.length);
    for (let index = 0; index < maxLength; index += 1) {
      const left = pendingDeleted[index] ? toSplitCell(pendingDeleted[index], "left") : null;
      const right = pendingAdded[index] ? toSplitCell(pendingAdded[index], "right") : null;
      splitRows.push({ kind: "line", left, right });
    }
    pendingDeleted = [];
    pendingAdded = [];
  };

  for (const row of rows) {
    if (row.kind === "hunk") {
      flushPending();
      splitRows.push({ kind: "hunk", text: row.text });
      continue;
    }

    if (row.kind === "meta") {
      flushPending();
      splitRows.push({ kind: "meta", text: row.text });
      continue;
    }

    if (row.kind === "del") {
      pendingDeleted.push(row);
      continue;
    }

    if (row.kind === "add") {
      pendingAdded.push(row);
      continue;
    }

    flushPending();
    splitRows.push({
      kind: "line",
      left: toSplitCell(row, "left"),
      right: toSplitCell(row, "right"),
    });
  }

  flushPending();
  return splitRows;
}

export function getUnifiedDiffRowClass(row: DiffRow): string {
  switch (row.kind) {
    case "hunk":
      return "bg-slate-100 text-slate-700 dark:bg-slate-900/60 dark:text-slate-200";
    case "meta":
      return "text-slate-500 dark:text-slate-400";
    case "add":
      return "border-l-2 border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-500/70 dark:bg-emerald-500/10 dark:text-emerald-200";
    case "del":
      return "border-l-2 border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-500/70 dark:bg-rose-500/10 dark:text-rose-200";
    case "context":
    default:
      return "text-slate-700 dark:text-slate-200";
  }
}
