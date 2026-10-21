import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  STUDIO_LOCATION_PROMPT,
  createStudioPermissionHandlers,
  decideStudioPermissionCheck,
  decideStudioPermissionRequest,
  parseStoredStudioLocationConsent,
} = await import(path.join(packageRoot, "dist", "studioPermissions.js"));

const STUDIO = "https://instafy.dev";
const studioTop = { isStudioContents: true, isMainFrame: true, requestingUrl: `${STUDIO}/studio/space/1` };
const previewFrame = { isStudioContents: true, isMainFrame: false, requestingUrl: "https://p-label.instafy.site/" };
const sameOriginSubframe = { isStudioContents: true, isMainFrame: false, requestingUrl: `${STUDIO}/embed` };
const foreignTop = { isStudioContents: true, isMainFrame: true, requestingUrl: "https://accounts.example.com/login" };
const notStudio = { isStudioContents: false, isMainFrame: true, requestingUrl: `${STUDIO}/` };
const granted = { decision: "granted", origin: STUDIO, decidedAt: "2026-10-13T00:00:00.000Z" };
const denied = { ...granted, decision: "denied" };

test("geolocation from any subframe is denied, even after Studio was allowed", () => {
  for (const frame of [previewFrame, sameOriginSubframe]) {
    for (const consent of [null, granted, denied]) {
      assert.equal(decideStudioPermissionRequest("geolocation", frame, STUDIO, consent), "deny");
      assert.equal(decideStudioPermissionCheck("geolocation", frame, STUDIO, consent), false);
    }
  }
});

test("geolocation from a top frame on another origin or a non-Studio window is denied", () => {
  for (const frame of [foreignTop, notStudio, { ...studioTop, isMainFrame: undefined }]) {
    assert.equal(decideStudioPermissionRequest("geolocation", frame, STUDIO, granted), "deny");
    assert.equal(decideStudioPermissionCheck("geolocation", frame, STUDIO, granted), false);
  }
});

test("Studio's own top frame asks once, then follows the remembered answer", () => {
  assert.equal(decideStudioPermissionRequest("geolocation", studioTop, STUDIO, null), "ask");
  assert.equal(decideStudioPermissionRequest("geolocation", studioTop, STUDIO, granted), "grant");
  assert.equal(decideStudioPermissionRequest("geolocation", studioTop, STUDIO, denied), "deny");
  // Undecided must not read as granted, or the check would skip the question.
  assert.equal(decideStudioPermissionCheck("geolocation", studioTop, STUDIO, null), false);
  assert.equal(decideStudioPermissionCheck("geolocation", studioTop, STUDIO, granted), true);
  assert.equal(decideStudioPermissionCheck("geolocation", studioTop, STUDIO, denied), false);
});

test("an answer given for another Studio origin does not carry over", () => {
  const otherOrigin = { ...granted, origin: "http://localhost:5173" };
  assert.equal(decideStudioPermissionRequest("geolocation", studioTop, STUDIO, otherOrigin), "ask");
  assert.equal(decideStudioPermissionCheck("geolocation", studioTop, STUDIO, otherOrigin), false);
});

test("Studio's own top frame, and other windows, keep Electron's no-handler default", () => {
  for (const permission of ["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "serial", "hid", "usb"]) {
    for (const frame of [studioTop, notStudio]) {
      assert.equal(decideStudioPermissionRequest(permission, frame, STUDIO, null), "grant", permission);
      assert.equal(decideStudioPermissionCheck(permission, frame, STUDIO, null), true, permission);
    }
  }
  assert.equal(decideStudioPermissionRequest("deprecated-sync-clipboard-read", studioTop, STUDIO, null), "deny");
  assert.equal(decideStudioPermissionCheck("deprecated-sync-clipboard-read", studioTop, STUDIO, null), false);
});

test("a frame inside Studio gets only fullscreen, clipboard writes and pointer lock", () => {
  const denied = ["notifications", "storage-access", "top-level-storage-access", "media", "background-sync", "sensors",
    "clipboard-read", "display-capture", "midi", "openExternal", "idle-detection", "window-management", "unknown"];
  // A check that names no frame but comes from the preview's origin is a subframe too.
  const unnamed = { isStudioContents: true, isMainFrame: undefined, requestingUrl: "https://p-label.instafy.site/" };
  for (const frame of [previewFrame, sameOriginSubframe, unnamed]) {
    for (const permission of denied) {
      assert.equal(decideStudioPermissionRequest(permission, frame, STUDIO, granted), "deny", permission);
      assert.equal(decideStudioPermissionCheck(permission, frame, STUDIO, granted), false, permission);
    }
    for (const permission of ["fullscreen", "clipboard-sanitized-write", "pointerLock"]) {
      assert.equal(decideStudioPermissionRequest(permission, frame, STUDIO, null), "grant", permission);
      assert.equal(decideStudioPermissionCheck(permission, frame, STUDIO, null), true, permission);
    }
  }
  // A check that names no window but says it comes from a subframe (a worker's background sync) is one too.
  const noWindow = { isStudioContents: null, isMainFrame: false, requestingUrl: "https://p-label.instafy.site/" };
  assert.equal(decideStudioPermissionCheck("background-sync", noWindow, STUDIO, null), false);
  assert.equal(decideStudioPermissionCheck("background-sync", { ...noWindow, isMainFrame: undefined }, STUDIO, null), true);
  // Studio's own checks that name no frame keep the default.
  assert.equal(decideStudioPermissionCheck("notifications", { ...studioTop, isMainFrame: undefined }, STUDIO, null), true);
});

test("stored consent is validated before it is trusted", () => {
  assert.deepEqual(parseStoredStudioLocationConsent(granted), granted);
  assert.equal(parseStoredStudioLocationConsent({ ...granted, decision: "yes" }), null);
  assert.equal(parseStoredStudioLocationConsent({ ...granted, origin: "https://instafy.dev/path" }), null);
  assert.equal(parseStoredStudioLocationConsent({ ...granted, origin: "null" }), null);
  assert.equal(parseStoredStudioLocationConsent("granted"), null);
  assert.equal(parseStoredStudioLocationConsent(undefined), null);
});

function harness({ answer = true, consent = null, studioContents = ["studio"] } = {}) {
  const state = { consent, asked: 0, writes: [] };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const handlers = createStudioPermissionHandlers({
    getStudioOrigin: () => STUDIO,
    isStudioContents: (contents) => studioContents.includes(contents),
    readConsent: () => state.consent,
    writeConsent: (next) => {
      state.consent = next;
      state.writes.push(next);
    },
    askUser: async () => {
      state.asked += 1;
      await gate;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => new Date("2026-10-13T12:00:00.000Z"),
  });
  const request = (contents, details) =>
    new Promise((resolve) => handlers.requestHandler(contents, "geolocation", resolve, details));
  return { state, handlers, request, release };
}

const topDetails = { isMainFrame: true, requestingUrl: `${STUDIO}/studio` };

test("the first Studio request shows one question; concurrent requests share it", async () => {
  const h = harness({ answer: true });
  const first = h.request("studio", topDetails);
  const second = h.request("studio", topDetails);
  h.release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(h.state.asked, 1);
  assert.deepEqual(h.state.consent, { decision: "granted", origin: STUDIO, decidedAt: "2026-10-13T12:00:00.000Z" });
  // Remembered: later requests are granted with no question.
  assert.equal(await h.request("studio", topDetails), true);
  assert.equal(h.state.asked, 1);
  assert.equal(h.handlers.checkHandler("studio", "geolocation", STUDIO, topDetails), true);
});

test("Don't Allow is remembered too, so sites cannot re-trigger the question", async () => {
  const h = harness({ answer: false });
  const first = h.request("studio", topDetails);
  h.release();
  assert.equal(await first, false);
  assert.equal(await h.request("studio", topDetails), false);
  assert.equal(h.state.asked, 1);
  assert.equal(h.handlers.locationPermissionState(), "denied");
});

test("a failed question denies without remembering", async () => {
  const h = harness({ answer: new Error("no window") });
  const first = h.request("studio", topDetails);
  h.release();
  assert.equal(await first, false);
  assert.equal(h.state.consent, null);
  assert.equal(h.handlers.locationPermissionState(), "ask");
});

test("subframe requests never show the question", async () => {
  const h = harness({ answer: true });
  h.release();
  assert.equal(await h.request("studio", { isMainFrame: false, requestingUrl: "https://p-label.instafy.site/" }), false);
  assert.equal(await h.request("other-window", topDetails), false);
  assert.equal(h.state.asked, 0);
  assert.equal(h.handlers.checkHandler(null, "geolocation", STUDIO, topDetails), false);
});

test("reset forgets the answer so the next request asks again", async () => {
  const h = harness({ answer: true, consent: granted });
  h.release();
  assert.equal(h.handlers.locationPermissionState(), "granted");
  assert.equal(h.handlers.resetLocationPermission(), "ask");
  assert.equal(h.state.consent, null);
  assert.equal(await h.request("studio", topDetails), true);
  assert.equal(h.state.asked, 1);
});

test("the question uses the spec's wording", () => {
  assert.equal(STUDIO_LOCATION_PROMPT.message, "Allow Instafy to use your location?");
  assert.equal(STUDIO_LOCATION_PROMPT.detail, "Sites you open can ask for it, and you'll see \u{1F4CD} when one does.");
});

const mainSource = readFileSync(path.join(packageRoot, "src", "main.ts"), "utf8");

test("the Studio window's session gets the handlers, and the menu can reset the answer", () => {
  const create = mainSource.slice(mainSource.indexOf("function createMainWindow("));
  const body = create.slice(0, create.indexOf("\nfunction "));
  assert.match(body, /registerStudioWindow\(mainWindow\);\s*installStudioPermissionHandlers\(mainWindow\);/);
  const install = mainSource.slice(mainSource.indexOf("function installStudioPermissionHandlers("));
  assert.match(install, /window\.webContents\.session/);
  assert.match(install, /setPermissionRequestHandler\(studioPermissionHandlers\.requestHandler\)/);
  assert.match(install, /setPermissionCheckHandler\(studioPermissionHandlers\.checkHandler\)/);
  const menu = mainSource.slice(mainSource.indexOf("function installDesktopApplicationMenu("));
  assert.equal(menu.match(/showStudioLocationPermissionDialog\(\)/g)?.length, 2, "macOS and Windows menus");
  // Studio's settings may read and reset the answer, never grant it.
  assert.match(mainSource, /"instafy:locationPermissionStatus"/);
  assert.match(mainSource, /"instafy:locationPermissionReset"/);
  assert.doesNotMatch(mainSource, /"instafy:locationPermission(Grant|Set|Allow)"/);
});

test("macOS builds can use Location Services", async () => {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const info = pkg.build.mac.extendInfo;
  assert.ok(info.NSLocationUsageDescription, "NSLocationUsageDescription");
  assert.ok(info.NSLocationWhenInUseUsageDescription, "NSLocationWhenInUseUsageDescription");
  const entitlements = readFileSync(path.join(packageRoot, pkg.build.mac.entitlements), "utf8");
  // Hardened Runtime denies Location Services without this entitlement.
  assert.match(entitlements, /<key>com\.apple\.security\.personal-information\.location<\/key>\s*<true\/>/);
  // electron-builder's defaults must survive the override.
  for (const key of ["allow-jit", "allow-unsigned-executable-memory", "disable-library-validation"]) {
    assert.match(entitlements, new RegExp(`<key>com\\.apple\\.security\\.cs\\.${key}</key>\\s*<true/>`));
  }
  const { MACOS_USAGE_DESCRIPTIONS } = await import(
    path.join(packageRoot, "scripts", "ensure-macos-bluetooth-usage.mjs")
  );
  // The dev launcher's bundle carries the same strings as the packaged app.
  assert.equal(MACOS_USAGE_DESCRIPTIONS.NSLocationUsageDescription, info.NSLocationUsageDescription);
  assert.equal(MACOS_USAGE_DESCRIPTIONS.NSLocationWhenInUseUsageDescription, info.NSLocationWhenInUseUsageDescription);
});

test("the installed handlers deny a preview frame's notifications and storage access, and a worker's background sync", async () => {
  const h = harness({ consent: granted });
  const frameDetails = { isMainFrame: false, requestingUrl: "https://p-label.instafy.site/" };
  for (const permission of ["notifications", "storage-access"]) {
    assert.equal(await new Promise((resolve) => h.handlers.requestHandler("studio", permission, resolve, frameDetails)), false, permission);
  }
  assert.equal(await new Promise((resolve) => h.handlers.requestHandler("studio", "fullscreen", resolve, frameDetails)), true);
  assert.equal(h.handlers.checkHandler(null, "background-sync", "https://p-label.instafy.site", frameDetails), false);
  assert.equal(h.handlers.checkHandler("studio", "notifications", STUDIO, topDetails), true);
});
