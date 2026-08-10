// The desktop Electron shell loads the same web app as prod.instafy.dev, so
// web-only chrome (landing-page links, marketing navigation) must be gated
// here rather than assumed away: inside the shell such links navigate the
// app window to pages that have no place in a desktop app and no way back.
// Detection relies on the preload bridge, which only the desktop shell
// injects (packages/desktop-app/src/preload.ts exposes `instafyDesktop`).

type ShellWindow = { instafyDesktop?: { windowChrome?: unknown } | unknown };

function defaultWindow(): ShellWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as ShellWindow);
}

export function isDesktopShell(shellWindow: ShellWindow | undefined = defaultWindow()): boolean {
  return Boolean(shellWindow?.instafyDesktop);
}

// The login page's "Back to landing" link exists for web visitors who arrived
// from the marketing site. Native apps, extension embeds, and the desktop
// shell all boot straight into login -- there is no landing page behind them,
// so the link must not render there.
export function showBackToLanding({
  isNativeApp,
  isExtensionEmbed,
  shellWindow,
}: {
  isNativeApp: boolean;
  isExtensionEmbed: boolean;
  shellWindow?: ShellWindow;
}): boolean {
  return !isNativeApp && !isExtensionEmbed && !isDesktopShell(shellWindow ?? defaultWindow());
}

// The shell's window chrome style, versioned through the bridge on purpose:
// a frontend older than the property keeps stock-title-bar spacing, and an
// app older than the integrated layout never exposes it, so mismatched
// halves always degrade to the safe stock layout instead of an undraggable
// window or overlapped traffic lights.
export function desktopWindowChrome(
  shellWindow: ShellWindow | undefined = defaultWindow(),
): "hiddenInset" | "system" | null {
  if (!isDesktopShell(shellWindow)) return null;
  const bridge = shellWindow?.instafyDesktop as { windowChrome?: unknown } | undefined;
  return bridge?.windowChrome === "hiddenInset" ? "hiddenInset" : "system";
}
