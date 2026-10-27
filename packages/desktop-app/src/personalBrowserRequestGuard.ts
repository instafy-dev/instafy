import type { Session } from "electron";

import {
  personalBrowserLinkOnlyMessage,
  type PersonalBrowserLinkOnlyGuard,
} from "./personalBrowserLinkOnly";
import {
  personalBrowserAddressIsProxy,
  personalBrowserConnectedAddressAllowed,
  personalBrowserProxyHosts,
} from "./personalBrowserSecurity";

export type PersonalBrowserStoppedLoad = { code: string; message: string };

export type PersonalBrowserRequestGuardOptions<Tab> = {
  /**
   * The tab whose request this is when the agent drives it, or null for
   * every request the agent's rules do not cover: a page load (`mainFrame`)
   * in a tab the agent drives, and a frame or a page's own request in a page
   * the agent opened there.
   */
  drivenTab(webContentsId: number | undefined, resourceType: string): Tab | null;
  /** A request of a driven tab was stopped: a page or frame load, or a page's own request (`resourceType`). */
  onStopped(tab: Tab, resourceType: string, stopped: PersonalBrowserStoppedLoad): void;
  linkOnly: PersonalBrowserLinkOnlyGuard;
  /** The public-address check made before a request leaves the browser; it resolves the host. */
  checkUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

const WEB_REQUESTS = { urls: ["http://*/*", "https://*/*"] };
const PAGE_REQUESTS = { ...WEB_REQUESTS, types: ["mainFrame", "subFrame"] as Array<"mainFrame" | "subFrame"> };

export const PERSONAL_BROWSER_PAGE_STOPPED = "Desktop stopped the page before it loaded; nothing there was read or done.";
const STOPPED = PERSONAL_BROWSER_PAGE_STOPPED;

export function personalBrowserPrivateAddressMessage(reason: string, action = STOPPED): string {
  return `The agent opens public web pages only, in every tab: ${reason}. ${action} Ask the person to open this address in their own tab.`;
}

function pageResourceType(value: string | undefined): "mainFrame" | "subFrame" | null {
  return value === "mainFrame" || value === "subFrame" ? value : null;
}

/**
 * Holds the requests the agent drives to the agent's rules, each redirect
 * hop included: page loads in a tab the agent drives, and the frames and own
 * requests of a page the agent opened. Requests of every other tab, of a page
 * the person opened, and the person's own browsing pass untouched.
 *
 * - Before a page or frame request leaves the browser: a link-only site is
 *   cancelled without any lookup, and a host that is not public, or resolves
 *   to an address that is not, is cancelled before it connects.
 * - When any response arrives, the page's own requests (scripts, images,
 *   fetch) included: Chromium resolves the name again to connect, so a name
 *   can answer with a public address for the check and a private one for the
 *   connection (DNS rebinding), also later, for a page that is already open.
 *   Every response reports the address Chromium actually connected to (`ip`,
 *   on every webRequest response event, not only the typed redirect one); one
 *   that is not public is cancelled before the page renders or receives it,
 *   so nothing from it is shown, read or followed. The request itself has
 *   reached that address by then. A response from the HTTP cache reports no
 *   address and keeps the check made before it; through a proxy the address
 *   is the proxy's, which resolved the name itself, so again only that first
 *   check applies. A request no tab makes (a service worker's own fetch) is
 *   not attributed to a tab and not checked.
 *
 * Electron allows one listener per event and session; this owns
 * onBeforeRequest and onHeadersReceived of the Personal Browser session.
 */
export function installPersonalBrowserRequestGuard<Tab>(session: Session, options: PersonalBrowserRequestGuardOptions<Tab>) {
  session.webRequest.onBeforeRequest(PAGE_REQUESTS, (details, callback) => {
    const resourceType = pageResourceType(details.resourceType);
    const tab = resourceType ? options.drivenTab(details.webContentsId, resourceType) : null;
    if (!tab || !resourceType) {
      callback({});
      return;
    }
    const linkOnly = options.linkOnly.refusal(details.url);
    if (linkOnly) {
      options.onStopped(tab, resourceType, { code: linkOnly.code, message: personalBrowserLinkOnlyMessage(linkOnly, STOPPED) });
      callback({ cancel: true });
      return;
    }
    void options.checkUrl(details.url).then(
      (check) => {
        if (!check.ok) {
          options.onStopped(tab, resourceType, { code: "private_address_blocked", message: personalBrowserPrivateAddressMessage(check.reason) });
        }
        callback({ cancel: !check.ok });
      },
      () => callback({ cancel: true }),
    );
  });
  session.webRequest.onHeadersReceived(WEB_REQUESTS, (details, callback) => {
    const tab = options.drivenTab(details.webContentsId, details.resourceType);
    if (!tab) {
      callback({});
      return;
    }
    const isProxy = async (address: string) =>
      personalBrowserAddressIsProxy(address, personalBrowserProxyHosts(await session.resolveProxy(details.url)));
    void personalBrowserConnectedAddressAllowed((details as { ip?: unknown }).ip, isProxy).then(
      (allowed) => {
        if (!allowed) {
          options.onStopped(tab, details.resourceType, {
            code: "private_address_blocked",
            message: personalBrowserPrivateAddressMessage("its server answered from a private or local address"),
          });
        }
        callback(allowed ? {} : { cancel: true });
      },
      () => callback({ cancel: true }),
    );
  });
}
