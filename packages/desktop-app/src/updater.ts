import { BrowserWindow, app, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { desktopLog } from "./logging";
import { settleDesktopUpdaterDownload } from "./desktopUpdaterDownload";
import {
  applyDesktopUpdaterDownloadProgress,
  clearDesktopUpdaterDownloadProgress,
  type DesktopUpdaterDownloadProgress,
} from "./desktopUpdaterProgress";

export type DesktopUpdaterPhase =
  | "idle"
  | "checking"
  | "update_available"
  | "downloading"
  | "downloaded"
  | "up_to_date"
  | "error";

export type DesktopUpdaterStatus = {
  isEnabled: boolean;
  channel: string;
  currentVersion: string;
  feedUrl: string;
  phase: DesktopUpdaterPhase;
  availableVersion?: string;
  lastCheckedAt?: string;
  lastDownloadedAt?: string;
  lastError?: string;
  lastInstallRequestAccepted?: boolean;
  downloadProgress?: DesktopUpdaterDownloadProgress;
};

export type DesktopUpdaterInstallRequest = {
  source: "native_prompt" | "renderer";
  availableVersion?: string;
};

export type DesktopUpdaterInstallRequestHandler = (
  request: DesktopUpdaterInstallRequest,
) => Promise<boolean> | boolean;

export type StartDesktopUpdaterOptions = {
  requestInstall?: DesktopUpdaterInstallRequestHandler;
};

const DEFAULT_DESKTOP_UPDATE_FEED_BASE_URL = "https://downloads.instafy.dev/desktop-app";
const DEFAULT_DESKTOP_UPDATE_CHANNEL = "stable";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let promptInFlight = false;
let pendingDownloadedPromptVersion: string | null = null;
let suppressAvailablePrompt = false;
let installRequestHandler: DesktopUpdaterInstallRequestHandler | null = null;
let installRequestInFlight: Promise<boolean> | null = null;

function resolveDesktopUpdateChannel(): string {
  const explicit = process.env.INSTAFY_DESKTOP_UPDATE_CHANNEL?.trim();
  return explicit || DEFAULT_DESKTOP_UPDATE_CHANNEL;
}

function resolveDesktopUpdateFeedUrl(channel: string): string {
  const explicit = process.env.INSTAFY_DESKTOP_UPDATE_FEED_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  return `${DEFAULT_DESKTOP_UPDATE_FEED_BASE_URL}/${channel}`;
}

function buildDesktopUpdaterStatus(): DesktopUpdaterStatus {
  const channel = resolveDesktopUpdateChannel();
  return {
    isEnabled: app.isPackaged,
    channel,
    currentVersion: app.getVersion(),
    feedUrl: resolveDesktopUpdateFeedUrl(channel),
    phase: "idle",
  };
}

function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(0) ?? null;
}

async function runDesktopUpdateCheck(options: { suppressPrompts?: boolean } = {}) {
  if (!app.isPackaged) {
    desktopUpdaterStatus.isEnabled = false;
    desktopUpdaterStatus.lastError = "Desktop updates are only available in packaged builds.";
    return desktopUpdaterStatus;
  }
  if (options.suppressPrompts) {
    suppressAvailablePrompt = true;
  }
  const updateWasDownloaded = desktopUpdaterStatus.phase === "downloaded";
  try {
    if (!updateWasDownloaded) {
      desktopUpdaterStatus.phase = "checking";
    }
    desktopUpdaterStatus.lastCheckedAt = new Date().toISOString();
    desktopUpdaterStatus.lastError = undefined;
    await autoUpdater.checkForUpdates();
    if (desktopUpdaterStatus.phase === "checking") {
      desktopUpdaterStatus.phase = "up_to_date";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!updateWasDownloaded) {
      desktopUpdaterStatus.phase = "error";
    }
    desktopUpdaterStatus.lastError = message;
    desktopLog("warn", "[instafy-desktop] updater check failed", {
      feedUrl: desktopUpdaterStatus.feedUrl,
      message,
    });
  } finally {
    if (
      desktopUpdaterStatus.phase === "up_to_date" ||
      desktopUpdaterStatus.phase === "error" ||
      desktopUpdaterStatus.phase === "idle"
    ) {
      suppressAvailablePrompt = false;
    }
  }
  return desktopUpdaterStatus;
}

async function downloadDesktopUpdateNow() {
  if (!app.isPackaged) {
    desktopUpdaterStatus.isEnabled = false;
    desktopUpdaterStatus.lastError = "Desktop updates are only available in packaged builds.";
    return desktopUpdaterStatus;
  }
  await settleDesktopUpdaterDownload(
    desktopUpdaterStatus,
    () => autoUpdater.downloadUpdate(),
    (message) => {
      desktopLog("warn", "[instafy-desktop] updater download failed", {
        feedUrl: desktopUpdaterStatus.feedUrl,
        message,
      });
    },
  );
  return desktopUpdaterStatus;
}

async function requestDownloadedDesktopUpdateInstall(
  source: DesktopUpdaterInstallRequest["source"],
) {
  if (!app.isPackaged || desktopUpdaterStatus.phase !== "downloaded") {
    desktopUpdaterStatus.lastInstallRequestAccepted = false;
    return desktopUpdaterStatus;
  }

  if (!installRequestHandler) {
    desktopUpdaterStatus.lastError = "Desktop update restart coordination is unavailable.";
    desktopUpdaterStatus.lastInstallRequestAccepted = false;
    desktopLog("warn", "[instafy-desktop] updater install request ignored", {
      reason: "install-request-handler-unavailable",
      source,
    });
    return desktopUpdaterStatus;
  }

  if (!installRequestInFlight) {
    const handler = installRequestHandler;
    const request: DesktopUpdaterInstallRequest = {
      source,
      availableVersion: desktopUpdaterStatus.availableVersion,
    };
    installRequestInFlight = Promise.resolve()
      .then(() => handler(request))
      .finally(() => {
        installRequestInFlight = null;
      });
  }

  const activeInstallRequest = installRequestInFlight;
  try {
    desktopUpdaterStatus.lastInstallRequestAccepted = await activeInstallRequest;
    desktopUpdaterStatus.lastError = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    desktopUpdaterStatus.lastError = message;
    desktopUpdaterStatus.lastInstallRequestAccepted = false;
    desktopLog("warn", "[instafy-desktop] updater install coordination failed", {
      message,
      source,
    });
  }
  return desktopUpdaterStatus;
}

export function isDesktopUpdaterReadyToInstall(): boolean {
  return app.isPackaged && desktopUpdaterStatus.phase === "downloaded";
}

/**
 * Performs the native installer handoff after the main process has approved an
 * update restart. Callers must complete runtime/job shutdown coordination first.
 */
export function performDesktopUpdaterInstallAfterQuitApproved(): boolean {
  if (!isDesktopUpdaterReadyToInstall()) {
    return false;
  }
  autoUpdater.quitAndInstall();
  return true;
}

function setWindowDownloadIndicator(value: number) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.setProgressBar(value);
  }
}

// The menu item's contract differs from background checks: a person clicked
// it, so silence is not an acceptable outcome. Found updates reuse the normal
// prompt flow; "already current" and failures get told to the user's face.
export async function checkForDesktopUpdatesInteractively() {
  const status = await runDesktopUpdateCheck();
  if (status.phase === "up_to_date") {
    const window = getFocusedWindow() ?? undefined;
    await dialog.showMessageBox(window, {
      type: "info",
      buttons: ["OK"],
      title: "You're up to date",
      message: `Instafy ${status.currentVersion} is the latest version.`,
    });
  } else if (status.phase === "error") {
    const window = getFocusedWindow() ?? undefined;
    await dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["OK"],
      title: "Could not check for updates",
      message: status.lastError ?? "The update check failed.",
      detail: "Check your connection and try again.",
    });
  }
  return status;
}

export function triggerDesktopUpdaterCheck() {
  return runDesktopUpdateCheck({ suppressPrompts: true });
}

export function triggerDesktopUpdaterDownload() {
  return downloadDesktopUpdateNow();
}

export function triggerDesktopUpdaterInstall() {
  return requestDownloadedDesktopUpdateInstall("renderer");
}

async function showDownloadedDesktopUpdatePrompt(version: string) {
  if (promptInFlight) {
    pendingDownloadedPromptVersion = version;
    return;
  }

  promptInFlight = true;
  try {
    const window = getFocusedWindow() ?? undefined;
    const result = await dialog.showMessageBox(window, {
      type: "info",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Instafy ${version} has been downloaded.`,
      detail: "Restart now to apply the update, or keep working and install it later.",
    });
    if (result.response === 0) {
      await requestDownloadedDesktopUpdateInstall("native_prompt");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    desktopLog("warn", "[instafy-desktop] updater restart prompt failed", { message });
  } finally {
    promptInFlight = false;
    const pendingVersion = pendingDownloadedPromptVersion;
    pendingDownloadedPromptVersion = null;
    if (pendingVersion) {
      void showDownloadedDesktopUpdatePrompt(pendingVersion);
    }
  }
}

export function startDesktopUpdater(options: StartDesktopUpdaterOptions = {}) {
  desktopUpdaterStatus.isEnabled = app.isPackaged;
  installRequestHandler = options.requestInstall ?? null;
  if (!app.isPackaged) {
    return;
  }

  suppressAvailablePrompt = false;
  pendingDownloadedPromptVersion = null;
  desktopUpdaterStatus.channel = resolveDesktopUpdateChannel();
  desktopUpdaterStatus.currentVersion = app.getVersion();
  desktopUpdaterStatus.feedUrl = resolveDesktopUpdateFeedUrl(desktopUpdaterStatus.channel);
  const feedUrl = desktopUpdaterStatus.feedUrl;
  autoUpdater.autoDownload = false;
  // Runtime jobs must be drained or explicitly abandoned before the app exits.
  // Never let electron-updater bypass the main-process quit coordinator.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feedUrl,
    // The downloads worker deliberately supports one RFC byte range per
    // request. Sequential ranges keep differential updates compatible with
    // R2 without requiring multipart/byteranges response assembly at the edge.
    useMultipleRangeRequest: false,
  });

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (desktopUpdaterStatus.phase !== "downloaded") {
      desktopUpdaterStatus.phase = "error";
    }
    desktopUpdaterStatus.lastError = message;
    setWindowDownloadIndicator(clearDesktopUpdaterDownloadProgress(desktopUpdaterStatus));
    desktopLog("warn", "[instafy-desktop] updater error", { feedUrl, message });
  });

  // The update download is large and previously gave no feedback at all
  // between "Download update" and the ready-to-install prompt. Progress now
  // reaches both surfaces users actually see: the dock icon (native progress
  // bar) and the renderer status the sidebar dialog polls.
  autoUpdater.on("download-progress", (event) => {
    setWindowDownloadIndicator(applyDesktopUpdaterDownloadProgress(desktopUpdaterStatus, event));
  });

  autoUpdater.on("update-available", async (info) => {
    if (desktopUpdaterStatus.phase === "downloaded") {
      suppressAvailablePrompt = false;
      return;
    }
    desktopUpdaterStatus.phase = "update_available";
    desktopUpdaterStatus.availableVersion = info.version;
    if (suppressAvailablePrompt) {
      suppressAvailablePrompt = false;
      return;
    }
    if (promptInFlight) {
      return;
    }
    promptInFlight = true;
    let shouldDownload = false;
    try {
      const window = getFocusedWindow() ?? undefined;
      const result = await dialog.showMessageBox(window, {
        type: "info",
        buttons: ["Download update", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update available",
        message: `Instafy ${info.version} is available.`,
        detail: "Download it now, then choose when to restart and install it.",
      });
      shouldDownload = result.response === 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      desktopLog("warn", "[instafy-desktop] updater prompt failed", { message });
    } finally {
      promptInFlight = false;
      const pendingVersion = pendingDownloadedPromptVersion;
      pendingDownloadedPromptVersion = null;
      if (pendingVersion) {
        void showDownloadedDesktopUpdatePrompt(pendingVersion);
      }
    }
    if (shouldDownload) {
      // EventEmitter does not observe rejected async-listener promises. The
      // download helper records failures into updater state and always settles.
      void downloadDesktopUpdateNow();
    }
  });

  autoUpdater.on("update-not-available", () => {
    setWindowDownloadIndicator(clearDesktopUpdaterDownloadProgress(desktopUpdaterStatus));
    if (desktopUpdaterStatus.phase === "downloaded") {
      suppressAvailablePrompt = false;
      return;
    }
    desktopUpdaterStatus.phase = "up_to_date";
    desktopUpdaterStatus.availableVersion = undefined;
    suppressAvailablePrompt = false;
  });

  autoUpdater.on("update-downloaded", async (info) => {
    setWindowDownloadIndicator(clearDesktopUpdaterDownloadProgress(desktopUpdaterStatus));
    desktopUpdaterStatus.phase = "downloaded";
    desktopUpdaterStatus.availableVersion = info.version;
    desktopUpdaterStatus.lastDownloadedAt = new Date().toISOString();
    await showDownloadedDesktopUpdatePrompt(info.version);
  });

  void runDesktopUpdateCheck();
  setInterval(() => {
    void runDesktopUpdateCheck();
  }, UPDATE_CHECK_INTERVAL_MS).unref();
}

export const desktopUpdaterStatus = buildDesktopUpdaterStatus();
