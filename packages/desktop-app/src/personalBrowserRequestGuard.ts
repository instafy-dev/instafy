import type { Session } from "electron";

import {
  personalBrowserLinkOnlyMessage,
  type PersonalBrowserLinkOnlyGuard,
} from "./personalBrowserLinkOnly";
import {
  personalBrowserAddressIsProxy,
  personalBrowserConnectedAddressAllowed,
  personalBrowserProxyHosts,
  personalBrowserRequestHostIsPublic,
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
  /**
   * The tab whose request is only watched, never stopped: one that holds a
   * page the agent opened, or a page that page opened, while the agent does
   * not drive the tab (the person has control). Null for every other request.
   */
  watchedTab?(webContentsId: number | undefined, resourceType: string): Tab | null;
  /**
   * What a watched request reached. `privateAddress` is true when it goes to,
   * or was answered from, a private or local address. A watched page load
   * (`mainFrame`) reports each hop as it starts (`request`), private or not,
   * so the page a load commits is judged by its own answer only.
   */
  onWatched?(tab: Tab, watched: { resourceType: string; url: string; phase: "request" | "response"; privateAddress: boolean }): void;
  linkOnly: PersonalBrowserLinkOnlyGuard;
  /** The public-address check made before a request leaves the browser; it resolves the host. */
  checkUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

const WEB_REQUESTS = { urls: ["http://*/*", "https://*/*"] };
// Chromium matches a WebSocket handshake by its own scheme, so the filter
// before a request leaves names ws and wss too. A handshake's response
// reports no connected address, so its name is resolved before it connects.
const ALL_REQUESTS = { urls: [...WEB_REQUESTS.urls, "ws://*/*", "wss://*/*"] };

export const PERSONAL_BROWSER_PAGE_STOPPED = "Desktop stopped the page before it loaded; nothing there was read or done.";
const STOPPED = PERSONAL_BROWSER_PAGE_STOPPED;

export function personalBrowserPrivateAddressMessage(reason: string, action = STOPPED): string {
  return `The agent opens public web pages only, in every tab: ${reason}. ${action} Ask the person to open this address in their own tab.`;
}

function pageResourceType(value: string | undefined): "mainFrame" | "subFrame" | null {
  return value === "mainFrame" || value === "subFrame" ? value : null;
}

// The public-address check resolves http(s) names; a WebSocket's name is the same host.
function asWebUrl(url: string): string {
  return url.replace(/^ws(s?):/i, "http$1:");
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
 * - Before a page's own request leaves (scripts, images, fetch, WebSockets):
 *   an address literal or local name that is not public is cancelled. A
 *   WebSocket's name is resolved too, since its handshake response reports
 *   no connected address.
 * - When any http(s) response arrives, the page's own requests included:
 *   Chromium resolves the name again to connect, so a name can answer with a
 *   public address for the check and a private one for the connection (DNS
 *   rebinding), also later, for a page that is already open. Every response
 *   reports the address Chromium actually connected to (`ip`, on every
 *   webRequest response event, not only the typed redirect one); one that is
 *   not public is cancelled before the page renders or receives it, so
 *   nothing from it is shown, read or followed. The request itself has
 *   reached that address by then. A response from the HTTP cache reports no
 *   address and keeps the check made before it; through a proxy the address
 *   is the proxy's, which resolved the name itself, so again only that first
 *   check applies. A request no tab makes (a service worker's own fetch) is
 *   not attributed to a tab and not checked.
 * - While the person has control, a page the agent opened (or one it opened
 *   in turn) is only watched: its requests go on, and one that reaches a
 *   private address is reported, so the agent does not read that page later.
 *
 * Electron allows one listener per event and session; this owns
 * onBeforeRequest and onHeadersReceived of the Personal Browser session.
 */
export function installPersonalBrowserRequestGuard<Tab>(session: Session, options: PersonalBrowserRequestGuardOptions<Tab>) {
  const isProxy = (url: string) => async (address: string) =>
    personalBrowserAddressIsProxy(address, personalBrowserProxyHosts(await session.resolveProxy(url)));
  session.webRequest.onBeforeRequest(ALL_REQUESTS, (details, callback) => {
    const resourceType = String(details.resourceType ?? "");
    const tab = options.drivenTab(details.webContentsId, resourceType);
    if (!tab) {
      callback({});
      watchRequest(details.webContentsId, resourceType, details.url);
      return;
    }
    const pageType = pageResourceType(resourceType);
    if (!pageType) {
      // A page's own request: an address literal or local name that is not
      // public never leaves the browser; a WebSocket's name is resolved too.
      if (!personalBrowserRequestHostIsPublic(details.url)) {
        options.onStopped(tab, resourceType, { code: "private_address_blocked", message: personalBrowserPrivateAddressMessage("that address is not a public one") });
        callback({ cancel: true });
        return;
      }
      if (resourceType !== "webSocket") {
        callback({});
        return;
      }
    } else {
      const linkOnly = options.linkOnly.refusal(details.url);
      if (linkOnly) {
        options.onStopped(tab, pageType, { code: linkOnly.code, message: personalBrowserLinkOnlyMessage(linkOnly, STOPPED) });
        callback({ cancel: true });
        return;
      }
    }
    void options.checkUrl(asWebUrl(details.url)).then(
      (check) => {
        if (!check.ok) {
          options.onStopped(tab, resourceType, { code: "private_address_blocked", message: personalBrowserPrivateAddressMessage(check.reason) });
        }
        callback({ cancel: !check.ok });
      },
      () => callback({ cancel: true }),
    );
  });

  // While the person has control, the requests of a page the agent opened go
  // on untouched; one that reaches a private address marks that page, which
  // the agent then does not read.
  function watchRequest(webContentsId: number | undefined, resourceType: string, url: string) {
    const tab = options.watchedTab?.(webContentsId, resourceType) ?? null;
    if (!tab || !options.onWatched) return;
    const report = (privateAddress: boolean) => options.onWatched?.(tab, { resourceType, url, phase: "request", privateAddress });
    const literalPublic = personalBrowserRequestHostIsPublic(url);
    if (!literalPublic || resourceType === "mainFrame") report(!literalPublic);
    if (literalPublic && resourceType === "webSocket") {
      void options.checkUrl(asWebUrl(url)).then((check) => { if (!check.ok) report(true); }, () => report(true));
    }
  }

  session.webRequest.onHeadersReceived(WEB_REQUESTS, (details, callback) => {
    const tab = options.drivenTab(details.webContentsId, details.resourceType);
    const ip = (details as { ip?: unknown }).ip;
    if (!tab) {
      callback({});
      const watched = options.watchedTab?.(details.webContentsId, details.resourceType) ?? null;
      if (watched && options.onWatched) {
        void personalBrowserConnectedAddressAllowed(ip, isProxy(details.url)).then(
          (allowed) => {
            if (!allowed) options.onWatched?.(watched, { resourceType: details.resourceType, url: details.url, phase: "response", privateAddress: true });
          },
          () => options.onWatched?.(watched, { resourceType: details.resourceType, url: details.url, phase: "response", privateAddress: true }),
        );
      }
      return;
    }
    void personalBrowserConnectedAddressAllowed(ip, isProxy(details.url)).then(
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
