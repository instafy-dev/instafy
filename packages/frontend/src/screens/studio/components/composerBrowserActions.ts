import type { BrowserTransport } from "./usePersonalBrowserBridge";

/**
 * The composer "+" menu's browser rows, which list only what can be done now:
 * **Open browser** while no browser is open, and **Ask AI for a new tab** (a
 * Shared Browser request) only while one is, since it adds a tab to it.
 */
export function composerBrowserActions({ transport, browserOpen }: {
  transport: BrowserTransport;
  browserOpen: boolean;
}): { showBrowserAction: boolean; showNewBrowserAction: boolean } {
  return {
    showBrowserAction: !browserOpen,
    showNewBrowserAction: transport === "shared" && browserOpen,
  };
}
