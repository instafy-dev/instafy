// The desktop Electron shell loads the same web app as prod.instafy.dev, so
// web-only chrome (landing-page links, marketing navigation) must be gated
// here rather than assumed away: inside the shell such links navigate the
// app window to pages that have no place in a desktop app and no way back.
// Detection relies on the preload bridge, which only the desktop shell
// injects (packages/desktop-app/src/preload.ts exposes `instafyDesktop`).

type ShellWindow = { instafyDesktop?: { windowChrome?: unknown } | unknown };

function defaultWindow(): (ShellWindow & { open?: Window["open"] }) | undefined {
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

/**
 * Height of the integrated title bar on macOS: exactly the tab strip's own
 * height, so the rail's top edge lands on the same row as the tab underline
 * and the two read as one continuous line. Deriving it from anything else
 * (for instance the shell's 38px drag inset) puts the rail 10px shy of that
 * line, which is visible.
 */
export const DESKTOP_TITLE_BAR_HEIGHT_PX = 48;

/** Left offset for the first tab, clearing the traffic lights. */
export const DESKTOP_TITLE_BAR_TAB_OFFSET_PX = 24;

/**
 * True when the shell has vacated the title bar and the frontend may place
 * interactive chrome at y=0.
 *
 * Gated on a bridge property the shell only started exposing alongside its
 * narrowed drag region. The frontend reaches installed apps the moment it is
 * published, so it routinely runs against older shells; on those the top row
 * is still covered by a full-width drag strip at maximum z-index, where a
 * raised tab would swallow clicks as window drags. Absent property means old
 * shell means stock layout.
 */
export function desktopTitleBarFree(
  shellWindow: ShellWindow | undefined = defaultWindow(),
): boolean {
  if (!isDesktopShell(shellWindow)) return false;
  const bridge = shellWindow?.instafyDesktop as { titleBarFree?: unknown } | undefined;
  return bridge?.titleBarFree === true;
}

type DesktopBridge = {
  openExternalUrl?: (url: string) => Promise<boolean>;
  consumePendingAuthCallback?: () => Promise<string | null>;
  onAuthCallback?: (listener: (url: string) => void) => () => void;
};

function bridge(): DesktopBridge | undefined {
  const w = defaultWindow() as { instafyDesktop?: DesktopBridge } | undefined;
  return w?.instafyDesktop;
}

// Opening the provider is a deliberate act, not a navigation the shell happens
// to intercept. Falls back to window.open, which the shell's window-open
// handler already routes externally, so this still works against a shell too
// old to expose the method.
export async function openDesktopExternalUrl(url: string): Promise<void> {
  const open = bridge()?.openExternalUrl;
  if (typeof open === "function") {
    await open(url);
    return;
  }
  defaultWindow()?.open?.(url, "_blank", "noopener");
}

// Drained on mount, because a callback can arrive before the renderer is
// listening -- or with no window at all.
export async function consumeDesktopAuthCallback(): Promise<string | null> {
  const consume = bridge()?.consumePendingAuthCallback;
  return typeof consume === "function" ? await consume() : null;
}

export function onDesktopAuthCallback(listener: (url: string) => void): () => void {
  const subscribe = bridge()?.onAuthCallback;
  return typeof subscribe === "function" ? subscribe(listener) : () => {};
}

// Whether THIS shell can actually receive an OAuth callback. The frontend is
// hosted and updates independently of the app, so a shell older than the
// callback bridge would send the user to the provider and then have nowhere to
// put the result -- turning a sign-in that finished in the wrong place into
// one that finishes nowhere. Old shells keep the previous behaviour until
// they update.
export function desktopCanReceiveAuthCallback(): boolean {
  const b = bridge();
  return typeof b?.onAuthCallback === "function" && typeof b?.consumePendingAuthCallback === "function";
}
