import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const { applyDesktopUpdaterDownloadProgress, clearDesktopUpdaterDownloadProgress } = await import(
  path.join(packageRoot, "dist", "desktopUpdaterProgress.js")
);

test("download progress reaches the status and the dock indicator", () => {
  // The regression this guards: 0.2.1 -> 0.2.2 shipped with download-progress
  // entirely unwired, so a ~120 MB download gave no feedback and the first
  // real user assumed the app had hung.
  const status = { phase: "update_available" };
  const bar = applyDesktopUpdaterDownloadProgress(status, {
    percent: 41.666,
    transferred: 50_000_000,
    total: 120_000_000,
    bytesPerSecond: 9_500_000,
  });
  assert.equal(status.phase, "downloading");
  assert.deepEqual(status.downloadProgress, {
    percent: 41.7,
    transferredBytes: 50_000_000,
    totalBytes: 120_000_000,
    bytesPerSecond: 9_500_000,
  });
  assert.ok(Math.abs(bar - 0.41666) < 0.001, "setProgressBar gets the 0..1 fraction");
});

test("out-of-range and malformed events cannot corrupt the indicator", () => {
  const status = { phase: "update_available" };
  assert.equal(applyDesktopUpdaterDownloadProgress(status, { percent: 104.2 }), 1);
  assert.equal(status.downloadProgress.percent, 100);
  assert.equal(applyDesktopUpdaterDownloadProgress(status, { percent: -3 }), 0);
  assert.equal(applyDesktopUpdaterDownloadProgress(status, { percent: Number.NaN }), 0);
  assert.equal(status.downloadProgress.totalBytes, 0);
});

test("clearing removes the progress state and the native indicator", () => {
  const status = { phase: "downloading" };
  applyDesktopUpdaterDownloadProgress(status, { percent: 80 });
  const bar = clearDesktopUpdaterDownloadProgress(status);
  assert.equal(bar, -1, "-1 is Electron's remove-progress-bar contract");
  assert.equal("downloadProgress" in status, false);
});
