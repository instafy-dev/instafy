import type { BugReportScreenshotPayload } from "../../../sdk/instafy";

export interface BugReportScreenshotDraft extends BugReportScreenshotPayload {
  id: string;
  previewUrl: string;
}

export const BUG_REPORT_MAX_SCREENSHOTS = 6;
export const BUG_REPORT_MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const BUG_REPORT_MAX_SCREENSHOT_TOTAL_BYTES = 12 * 1024 * 1024;
export const BUG_REPORT_SCREENSHOT_ACCEPT = "image/png,image/jpeg,image/webp";

const SUPPORTED_SCREENSHOT_MEDIA_TYPES = new Set(
  BUG_REPORT_SCREENSHOT_ACCEPT.split(","),
);

export function isSupportedBugReportScreenshotMediaType(mediaType: string): boolean {
  return SUPPORTED_SCREENSHOT_MEDIA_TYPES.has(mediaType.trim().toLowerCase());
}

function requireSupportedScreenshotMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  if (!SUPPORTED_SCREENSHOT_MEDIA_TYPES.has(normalized)) {
    throw new Error("Screenshots must be PNG, JPEG, or WebP images.");
  }
  return normalized;
}

function createDraftId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bug-shot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseDataUrl(dataUrl: string): { mediaType: string; dataBase64: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Unable to encode screenshot.");
  }
  return {
    mediaType: requireSupportedScreenshotMediaType(match[1] || "image/png"),
    dataBase64: match[2],
  };
}

function estimateBase64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.startsWith("data:")) {
        reject(new Error(`Unable to read ${file.name}.`));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function formatBugReportFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function assertBugReportScreenshotTotalBytes(totalBytes: number): void {
  if (totalBytes > BUG_REPORT_MAX_SCREENSHOT_TOTAL_BYTES) {
    throw new Error("Screenshots must total 12 MB or less.");
  }
}

export async function buildBugReportScreenshotDrafts(
  files: File[],
  existing: readonly Pick<BugReportScreenshotDraft, "byteLength">[] = [],
): Promise<BugReportScreenshotDraft[]> {
  const remainingSlots = Math.max(0, BUG_REPORT_MAX_SCREENSHOTS - existing.length);
  if (remainingSlots === 0) {
    throw new Error(`You can attach up to ${BUG_REPORT_MAX_SCREENSHOTS} screenshots.`);
  }

  const selected = files
    .filter((file) => isSupportedBugReportScreenshotMediaType(file.type))
    .slice(0, remainingSlots);

  if (selected.length === 0) {
    throw new Error("Choose a PNG, JPEG, or WebP screenshot to attach.");
  }

  for (const file of selected) {
    if (file.size > BUG_REPORT_MAX_SCREENSHOT_BYTES) {
      throw new Error(`${file.name} is larger than 4 MB.`);
    }
  }
  assertBugReportScreenshotTotalBytes(
    existing.reduce((total, screenshot) => total + screenshot.byteLength, 0) +
      selected.reduce((total, file) => total + file.size, 0),
  );

  const drafts = await Promise.all(
    selected.map(async (file) => {
      const previewUrl = await readFileAsDataUrl(file);
      const commaIndex = previewUrl.indexOf(",");
      if (commaIndex < 0) {
        throw new Error(`Unable to encode ${file.name}.`);
      }
      return {
        id: createDraftId(),
        fileName: file.name || "screenshot.png",
        mediaType: requireSupportedScreenshotMediaType(file.type),
        byteLength: file.size,
        dataBase64: previewUrl.slice(commaIndex + 1),
        previewUrl,
      } satisfies BugReportScreenshotDraft;
    }),
  );

  return drafts;
}

export function buildBugReportScreenshotDraftFromDataUrl(
  dataUrl: string,
  options?: {
    fileName?: string;
  },
): BugReportScreenshotDraft {
  const { mediaType, dataBase64 } = parseDataUrl(dataUrl);
  const byteLength = estimateBase64ByteLength(dataBase64);
  if (byteLength > BUG_REPORT_MAX_SCREENSHOT_BYTES) {
    const fileName = options?.fileName || "screenshot.png";
    throw new Error(`${fileName} is larger than 4 MB.`);
  }
  return {
    id: createDraftId(),
    fileName: options?.fileName || "screenshot.png",
    mediaType,
    byteLength,
    dataBase64,
    previewUrl: dataUrl,
  };
}
