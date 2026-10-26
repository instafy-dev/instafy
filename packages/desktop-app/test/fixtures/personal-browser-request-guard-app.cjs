// A minimal Electron main process for the Personal Browser smoke: browser
// sessions wired with Desktop's own built request guard, so a real Chromium
// shows which page loads of a tab the agent drives are stopped, and when.
// Every name it loads resolves to the loopback fixture server or not at all:
// Chromium never contacts a real site.
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const dist = path.join(__dirname, "..", "..", "dist");
const { installPersonalBrowserRequestGuard } = require(path.join(dist, "personalBrowserRequestGuard.js"));
const { PERSONAL_BROWSER_LINK_ONLY_GUARD } = require(path.join(dist, "personalBrowserLinkOnly.js"));

app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP *.guard.test 127.0.0.1, MAP www.booking.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
);
app.on("window-all-closed", () => undefined);

let sequence = 0;

/**
 * Loads fixture pages in a tab the agent drives and in one it does not.
 * `origin` is the fixture server, `proxy` a forward proxy in front of it.
 */
globalThis.__instafyRequestGuardScenario = async ({ origin, proxy }) => {
  await app.whenReady();
  const port = new URL(origin).port;
  const stopped = [];
  const driven = new Set();
  const guarded = async (proxyRules) => {
    const guardedSession = session.fromPartition(`request-guard-${process.pid}-${(sequence += 1)}`);
    if (proxyRules) await guardedSession.setProxy({ proxyRules });
    installPersonalBrowserRequestGuard(guardedSession, {
      drivenTab: (webContentsId) => (driven.has(webContentsId) ? webContentsId : null),
      onStopped: (_tab, resourceType, load) => stopped.push({ resourceType, code: load.code }),
      linkOnly: PERSONAL_BROWSER_LINK_ONLY_GUARD,
      // Every name passes the check made before the request, as the first
      // answer of a rebinding name does; Chromium then connects to loopback.
      checkUrl: async () => ({ ok: true }),
    });
    return guardedSession;
  };
  const tab = (tabSession, agentDriven) => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session: tabSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    if (agentDriven) driven.add(window.webContents.id);
    return window;
  };
  const load = async (window, url) => {
    try {
      await window.webContents.loadURL(url);
      return "loaded";
    } catch (error) {
      return error && typeof error.code === "string" ? error.code : String(error);
    }
  };
  const visibleText = (window) => window.webContents.executeJavaScript("document.body ? document.body.innerText : ''");
  const outcome = async (window, url) => {
    const result = await load(window, url);
    return { result, text: await visibleText(window) };
  };
  // A page already open that fetches a rebinding name again: what its script
  // gets back, or "blocked".
  const fetched = async (window, url) => {
    const script = `fetch(${JSON.stringify(url)}).then((r) => r.text()).then(` +
      "(text) => { document.body.dataset.fetched = text; }, () => { document.body.dataset.fetched = 'blocked'; });";
    await load(window, `data:text/html,${encodeURIComponent(`<!doctype html><body><script>${script}</script></body>`)}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await window.webContents.executeJavaScript("document.body.dataset.fetched || ''");
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return "no answer";
  };

  const direct = await guarded(null);
  const viaProxy = await guarded(`http=${new URL(proxy).host}`);
  const agentTab = tab(direct, true);
  const proxiedAgentTab = tab(viaProxy, true);
  const personTab = tab(direct, false);
  const results = {
    rebound: await outcome(agentTab, `http://rebound.guard.test:${port}/guard/page`),
    linkOnly: await outcome(agentTab, `http://www.booking.com:${port}/guard/page`),
    viaProxy: await outcome(proxiedAgentTab, `http://page.guard.test:${port}/guard/page`),
    viaProxyToLinkOnly: await outcome(proxiedAgentTab, `http://hop.guard.test:${port}/guard/to-link-only`),
    person: await outcome(personTab, `http://rebound.guard.test:${port}/guard/page`),
    fetched: await fetched(agentTab, `http://rebound.guard.test:${port}/guard/data`),
    personFetched: await fetched(personTab, `http://rebound.guard.test:${port}/guard/data`),
    stopped,
  };
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  return results;
};
