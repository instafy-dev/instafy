import { BrowserWindow, app, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { desktopLog } from "./logging";

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
};

const DEFAULT_DESKTOP_UPDATE_FEED_BASE_URL = "https://downloads.instafy.dev/desktop-app";
const DEFAULT_DESKTOP_UPDATE_CHANNEL = "stable";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let promptInFlight = false;
let suppressAvailablePrompt = false;
let suppressDownloadedPrompt = false;

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
  try {
    desktopUpdaterStatus.phase = "checking";
    desktopUpdaterStatus.lastCheckedAt = new Date().toISOString();
    desktopUpdaterStatus.lastError = undefined;
    await autoUpdater.checkForUpdates();
    if (desktopUpdaterStatus.phase === "checking") {
      desktopUpdaterStatus.phase = "up_to_date";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    desktopUpdaterStatus.phase = "error";
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
  suppressDownloadedPrompt = true;
  desktopUpdaterStatus.phase = "downloading";
  desktopUpdaterStatus.lastError = undefined;
  await autoUpdater.downloadUpdate();
  return desktopUpdaterStatus;
}

function installDownloadedDesktopUpdateNow() {
  if (!app.isPackaged || desktopUpdaterStatus.phase !== "downloaded") {
    return desktopUpdaterStatus;
  }
  setImmediate(() => autoUpdater.quitAndInstall());
  return desktopUpdaterStatus;
}

export function triggerDesktopUpdaterCheck() {
  return runDesktopUpdateCheck({ suppressPrompts: true });
}

export function triggerDesktopUpdaterDownload() {
  return downloadDesktopUpdateNow();
}

export function triggerDesktopUpdaterInstall() {
  return installDownloadedDesktopUpdateNow();
}

export function startDesktopUpdater() {
  desktopUpdaterStatus.isEnabled = app.isPackaged;
  if (!app.isPackaged) {
    return;
  }

  suppressAvailablePrompt = false;
  suppressDownloadedPrompt = false;
  desktopUpdaterStatus.channel = resolveDesktopUpdateChannel();
  desktopUpdaterStatus.currentVersion = app.getVersion();
  desktopUpdaterStatus.feedUrl = resolveDesktopUpdateFeedUrl(desktopUpdaterStatus.channel);
  const feedUrl = desktopUpdaterStatus.feedUrl;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feedUrl,
  });

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    desktopUpdaterStatus.phase = "error";
    desktopUpdaterStatus.lastError = message;
    desktopLog("warn", "[instafy-desktop] updater error", { feedUrl, message });
  });

  autoUpdater.on("update-available", async (info) => {
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
    try {
      const window = getFocusedWindow() ?? undefined;
      const result = await dialog.showMessageBox(window, {
        type: "info",
        buttons: ["Download update", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update available",
        message: `Instafy Studio ${info.version} is available.`,
        detail: "Download the update now and install it when you restart the app.",
      });
      if (result.response === 0) {
        await downloadDesktopUpdateNow();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      desktopLog("warn", "[instafy-desktop] updater prompt failed", { message });
    } finally {
      promptInFlight = false;
    }
  });

  autoUpdater.on("update-downloaded", async (info) => {
    desktopUpdaterStatus.phase = "downloaded";
    desktopUpdaterStatus.availableVersion = info.version;
    desktopUpdaterStatus.lastDownloadedAt = new Date().toISOString();
    if (suppressDownloadedPrompt) {
      suppressDownloadedPrompt = false;
      return;
    }
    try {
      const window = getFocusedWindow() ?? undefined;
      const result = await dialog.showMessageBox(window, {
        type: "info",
        buttons: ["Restart and install", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update ready",
        message: `Instafy Studio ${info.version} has been downloaded.`,
        detail: "Restart now to apply the update, or keep working and install it later.",
      });
      if (result.response === 0) {
        installDownloadedDesktopUpdateNow();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      desktopLog("warn", "[instafy-desktop] updater restart prompt failed", { message });
    }
  });

  void runDesktopUpdateCheck();
  setInterval(() => {
    void runDesktopUpdateCheck();
  }, UPDATE_CHECK_INTERVAL_MS).unref();
}

export const desktopUpdaterStatus = buildDesktopUpdaterStatus();
