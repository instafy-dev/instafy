export function normalizeAssistantStatusText(value: string): string {
  return value.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
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
