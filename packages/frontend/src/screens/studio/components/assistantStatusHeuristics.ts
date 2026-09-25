export function normalizeAssistantStatusText(value: string): string {
  return value.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

// A bold run that opens the text and ends its own line, as in "**Heading**\n\nBody".
const LEADING_BOLD_HEADING_PATTERN = /^\s*\*\*(.+?)\*\*[^\S\r\n]*(?:\r?\n|$)/;

// Codex writes each reasoning summary part as "**Heading**\n\nBody". A one-line
// live status shows only the heading, the way Codex's own status indicator does
// with extract_first_bold. The body is the model's deliberation and already lives
// behind "Agent thinking", so flattening it into the status row would leak it.
// Text without such a heading keeps only its first line, which leaves ordinary
// one-line statuses like "Thinking…" or "Retrying: …" unchanged.
export function resolveAssistantStatusHeadline(value: string): string {
  const heading = LEADING_BOLD_HEADING_PATTERN.exec(value)?.[1];
  const normalizedHeading = heading ? normalizeAssistantStatusText(heading) : "";
  if (normalizedHeading) {
    return normalizedHeading;
  }
  const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? "";
  return normalizeAssistantStatusText(firstLine);
}

function normalizeAssistantStatusLabel(value: string): string {
  return normalizeAssistantStatusText(value)
    .toLowerCase()
    .replace(/\.\.\.$/, "")
    .replace(/…$/, "")
    .replace(/[.!]+$/g, "");
}

export function isCompactionStatusText(value: string): boolean {
  const normalized = normalizeAssistantStatusLabel(value);
  if (!normalized) {
    return false;
  }
  if (
    normalized.includes("context automatically compacted") ||
    normalized.includes("re-organizing my thoughts") ||
    normalized.includes("reorganizing my thoughts")
  ) {
    return true;
  }
  const hasCompactionSignal = /\b(compact|compacted|compacting|compression|compress|compressed|compressing)\b/.test(
    normalized,
  );
  if (!hasCompactionSignal) {
    return false;
  }
  return /\b(context|history|conversation|thread|prompt)\b/.test(normalized);
}

export function looksLikeInternalLearnedBlocksStatus(value: string): boolean {
  const normalized = normalizeAssistantStatusLabel(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("loaded learned blocks:") ||
    normalized.startsWith("loading learned blocks") ||
    normalized.startsWith("loaded learned block:") ||
    normalized.startsWith("loaded memory blocks:") ||
    normalized.startsWith("loading memory blocks")
  );
}
