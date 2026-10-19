// Native proof of the Studio window's popup rule (externalUrls.ts) in real
// Electron: a cross-origin frame with Studio's provider-surface sandbox opens
// popups with no click (Electron has no popup blocker). Every one reaches the
// window-open handler, and only the https one would be handed to the OS.
// Nothing is ever opened: the "open" side is a recorder.
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-window-open-smoke-"));
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const servers = [];
function finish(code) {
  for (const server of servers) server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => {
  console.error("window-open smoke timed out");
  finish(1);
}, 30000).unref();

// Keep in step with ProviderHostSurfaceSandboxContainer.tsx (frontend).
const SANDBOX = "allow-forms allow-modals allow-popups allow-scripts";
const URLS = ["smb://attacker.invalid/share", "vscode://file/tmp/x", "x-instafy-smoke://deep", "https://example.com/source"];
const frameHtml = `<script>
${JSON.stringify(URLS)}.forEach(function (u) { window.open(u); });
var a = document.createElement("a"); a.href = "x-instafy-smoke://anchor"; a.target = "_blank";
document.documentElement.appendChild(a); a.click();
</script>`;

function listen(html) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

app
  .whenReady()
  .then(async () => {
    const { externalBrowserUrl } = require("../dist/externalUrls.js");
    const framePort = await listen(frameHtml);
    const studioPort = await listen(
      `<iframe sandbox="${SANDBOX}" referrerpolicy="no-referrer" src="http://localhost:${framePort}/"></iframe>`,
    );
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const seen = [];
    const opened = [];
    // Same shape as main.ts, with the OS call replaced by a recorder.
    win.webContents.setWindowOpenHandler(({ url }) => {
      seen.push(url);
      const external = externalBrowserUrl(url);
      if (external) opened.push(external);
      return { action: "deny" };
    });
    await win.loadURL(`http://127.0.0.1:${studioPort}/`);
    const end = Date.now() + 10000;
    while (seen.length < URLS.length + 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, URLS.length + 1, `handler saw ${JSON.stringify(seen)}`);
    assert.deepEqual(opened, ["https://example.com/source"]);
    console.log(JSON.stringify({ seen: seen.length, opened }));
    finish(0);
  })
  .catch((error) => {
    console.error(error);
    finish(1);
  });
