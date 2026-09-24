import type { BrowserWindow } from "electron";

// Hidden page renderers are not Studio windows. Register the trusted shell
// explicitly so deep links, credentials and dialogs never target an Explore page.
const windows = new Set<BrowserWindow>();
export function registerStudioWindow(window: BrowserWindow) {
  windows.add(window);
  window.once("closed", () => windows.delete(window));
}
export function getStudioWindows(): BrowserWindow[] {
  return [...windows].filter((window) => !window.isDestroyed());
}
export function getStudioWindow(): BrowserWindow | null {
  const current = getStudioWindows();
  return current.find((window) => window.isFocused()) ?? current[0] ?? null;
}
