// The one rule for handing a URL to the operating system.
//
// Studio frames content it does not control (provider surfaces today, site
// previews later), and Electron has no popup blocker, so any window.open from
// such a frame reaches the window's open handler with no click. shell.openExternal launches whatever handler is
// registered for a scheme (smb:, vscode:, ms-msdt:, an app's deep link…), so
// only web URLs may leave the app this way; they open in the default browser.
// Everything else is dropped silently. Free of Electron imports so it can be
// unit-tested.

/** The normalised URL to open in the browser, or null when it must not leave the app. */
export function externalBrowserUrl(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.toString();
}
