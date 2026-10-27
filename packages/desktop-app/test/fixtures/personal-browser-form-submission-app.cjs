// A minimal Electron main process for the Personal Browser smoke: one form
// step of the form-submission table both browsers run, through Desktop's own
// built page bridge and step rules, in real Chromium. Each page sits in a
// sandboxed, isolated window that, like a Personal Browser tab, opens no
// other window. Every name it loads resolves to the loopback fixture server
// or not at all: Chromium never contacts a real site.
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const dist = path.join(__dirname, "..", "..", "dist");
const bridge = require(path.join(dist, "personalBrowserPageBridge.js"));
const security = require(path.join(dist, "personalBrowserSecurity.js"));

app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP shop.test 127.0.0.1, MAP other.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
);
app.on("window-all-closed", () => undefined);

let sequence = 0;

/**
 * Loads `<shop>/case/<name>`, reads the step element's descriptor (id
 * "step"), judges the step as the Personal Browser host does, then takes it
 * with the page bridge (a click, or Enter) and waits for what it sends.
 */
globalThis.__instafyFormSubmissionStep = async ({ shop, name, step }) => {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      session: session.fromPartition(`form-submission-${process.pid}-${(sequence += 1)}`),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const deniedWindows = [];
  window.webContents.setWindowOpenHandler((details) => {
    deniedWindows.push(details.url);
    return { action: "deny" };
  });
  try {
    await window.loadURL(`${shop}/case/${encodeURIComponent(name)}`);
    const contents = window.webContents;
    const pageUrl = contents.getURL();
    const snapshot = await bridge.snapshotPersonalBrowserPage(contents);
    const item = snapshot.interactive.find((candidate) => candidate.descriptor.id === "step");
    if (!item) return { observed: false };
    const descriptor = item.descriptor;
    const facts = {
      via: descriptor.formSubmission,
      submits: descriptor.formSubmits,
      action: descriptor.formActionUrl,
      method: descriptor.formMethod,
      enctype: descriptor.formEnctype,
      target: descriptor.formTarget,
      newWindow: descriptor.formNewWindow,
    };
    const judged = {
      enterVerdict: security.classifyPersonalBrowserStep("press", descriptor, { key: "Enter", pageUrl }).verdict,
      enterAsksInRoutine: security.personalBrowserKeyRequiresConfirmation("Enter", descriptor, "routine", { pageUrl }),
      enterAsksInAsk: security.personalBrowserKeyRequiresConfirmation("Enter", descriptor, "ask", { pageUrl }),
      clickAsksInRoutine: security.personalBrowserActivationRequiresConfirmation(descriptor, "routine", { pageUrl }),
      submission: security.personalBrowserStepFormSubmission(descriptor, step === "click" ? "click" : "press", "Enter"),
    };
    const expectation = bridge.personalBrowserTargetExpectation(
      descriptor,
      security.personalBrowserTargetSecurityFingerprint(descriptor),
    );
    const result = step === "click"
      ? await bridge.clickPersonalBrowserTarget(contents, { index: item.index }, expectation)
      : await bridge.pressPersonalBrowserTarget(contents, { index: item.index }, "Enter", expectation);
    // The request a submission sends leaves well within this.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return {
      observed: true,
      pageUrl,
      facts,
      ...judged,
      performed: result.clicked === true || result.pressed === true,
      targetChanged: result.targetChanged,
      deniedWindows,
    };
  } finally {
    window.destroy();
  }
};
