import type { BugReportScreenshotPayload } from "../../../sdk/instafy";

export interface BugReportScreenshotDraft extends BugReportScreenshotPayload {
  id: string;
  previewUrl: string;
}

export const BUG_REPORT_MAX_SCREENSHOTS = 6;
export const BUG_REPORT_MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

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
    mediaType: match[1] || "image/png",
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

export async function buildBugReportScreenshotDrafts(
  files: File[],
  existingCount = 0,
): Promise<BugReportScreenshotDraft[]> {
  const remainingSlots = Math.max(0, BUG_REPORT_MAX_SCREENSHOTS - existingCount);
  if (remainingSlots === 0) {
    throw new Error(`You can attach up to ${BUG_REPORT_MAX_SCREENSHOTS} screenshots.`);
  }

  const selected = files
    .filter((file) => file.type.startsWith("image/"))
    .slice(0, remainingSlots);

  if (selected.length === 0) {
    throw new Error("Choose an image screenshot to attach.");
  }

  for (const file of selected) {
    if (file.size > BUG_REPORT_MAX_SCREENSHOT_BYTES) {
      throw new Error(`${file.name} is larger than 4 MB.`);
    }
  }

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
        mediaType: file.type || "image/png",
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
