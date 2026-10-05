// The facts under an open file in Files. A fact whose value is unknown is
// left out rather than drawn as a placeholder: files read from saved
// history have no modified time.

export interface FileViewerFact {
  label: "Size" | "Modified" | "MIME";
  value: string;
}

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

export function formatModifiedTimestamp(timestamp: string | null | undefined): string | null {
  const trimmed = timestamp?.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toLocaleString();
}

export function describeFileViewerFacts(file: {
  size?: number | null;
  modified?: string | null;
  mimeType?: string | null;
}): FileViewerFact[] {
  const facts: FileViewerFact[] = [];
  const size = formatFileSize(file.size);
  if (size) {
    facts.push({ label: "Size", value: size });
  }
  const modified = formatModifiedTimestamp(file.modified);
  if (modified) {
    facts.push({ label: "Modified", value: modified });
  }
  const mimeType = file.mimeType?.trim();
  if (mimeType) {
    facts.push({ label: "MIME", value: mimeType });
  }
  return facts;
}
