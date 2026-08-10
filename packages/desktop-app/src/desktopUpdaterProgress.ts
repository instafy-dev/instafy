// Download progress for desktop updates. Extracted from the event glue so the
// arithmetic is testable against the built output, matching how the download
// settle logic is tested.
//
// Why this exists at all: the update download is ~120 MB, and 0.2.1 -> 0.2.2
// shipped with no feedback between clicking "Download update" and the
// "Update ready" dialog. The first real user assumed the app had hung.

export type DesktopUpdaterDownloadProgress = {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
};

type ProgressEventLike = {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

type StatusLike = {
  phase: string;
  downloadProgress?: DesktopUpdaterDownloadProgress;
};

function asNonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Applies a progress event to the updater status and returns the value for
// BrowserWindow.setProgressBar: a 0..1 fraction while downloading. Percent is
// clamped because electron-updater has historically reported values a hair
// outside 0..100 around the edges of a differential download.
export function applyDesktopUpdaterDownloadProgress(
  status: StatusLike,
  event: ProgressEventLike,
): number {
  const percent = Math.min(100, asNonNegativeFinite(event.percent));
  status.phase = "downloading";
  status.downloadProgress = {
    percent: Math.round(percent * 10) / 10,
    transferredBytes: asNonNegativeFinite(event.transferred),
    totalBytes: asNonNegativeFinite(event.total),
    bytesPerSecond: asNonNegativeFinite(event.bytesPerSecond),
  };
  return percent / 100;
}

// Clears progress state and returns the setProgressBar value that removes the
// native progress indicator (-1 per Electron's contract).
export function clearDesktopUpdaterDownloadProgress(status: StatusLike): number {
  delete status.downloadProgress;
  return -1;
}
