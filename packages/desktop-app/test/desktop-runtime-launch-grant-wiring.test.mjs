import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// main.ts runs only in Electron, which these tests do not start, so its
// runtime launch grant wiring (docs/Local-Engine-Turns.md 4.3) is asserted on
// its source, as mac-window-chrome.test.mjs does for the window chrome. The
// decisions it calls are tested in desktop-runtime-activity.test.mjs and
// desktop-extension-registry.test.mjs.

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const mainSource = readFileSync(path.join(srcDir, "main.ts"), "utf8");
const preloadSource = readFileSync(path.join(srcDir, "preload.ts"), "utf8");

// From an opening brace to its matching closing one, skipping string and
// template literals and comments.
function balancedBlock(source, openIndex) {
  assert.equal(source[openIndex], "{", "a block starts with a brace");
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) {
        if (source[index] === "\\") {
          index += 1;
        }
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index) + 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
  }
  throw new Error("unbalanced block");
}

function blockAfter(marker) {
  const start = mainSource.indexOf(marker);
  assert.ok(start >= 0, `main.ts has ${marker}`);
  return balancedBlock(mainSource, mainSource.indexOf("{", start + marker.length));
}

function functionBody(name) {
  return blockAfter(`function ${name}(`);
}

test("every runtime start passes launch grants, so their keys are stripped from each one", () => {
  const starts = [...mainSource.matchAll(/\bstartDesktopRuntime\(/g)];
  assert.ok(starts.length >= 3, "the start handler, the Personal Browser resume and a consent change's replacement");
  for (const match of starts) {
    const open = match.index + match[0].length;
    assert.equal(mainSource[open], "{", "a start's options are written out where it is called");
    assert.match(
      balancedBlock(mainSource, open),
      /\blaunchGrants:\s*desktopRuntimeLaunchGrantsForStart\(/,
      "desktop-runtime-agent strips nothing without launchGrants",
    );
  }
});

test("a start bound to the visible session is granted for its user, and a Personal Browser start for nobody", () => {
  const handler = blockAfter('"instafy:startDesktopRuntime"');
  assert.match(
    handler,
    /const launchGrantUserId = resolveDesktopRuntimeLaunchGrantUserId\(\{\s*enablePersonalBrowser,\s*boundUserId: trustedControllerBinding\.boundUserId,\s*\}\);/,
  );
  assert.match(
    handler,
    /resolveDesktopRuntimeLaunchGrants\(\{[^}]*instafyUserId: launchGrantUserId,[^}]*\}\)/,
  );

  // The resume replays saved options, so it is granted nothing.
  const resume = functionBody("resumePersonalBrowserRuntime");
  assert.match(resume, /const launchGrants = CURRENT_DESKTOP_EXTENSION_REGISTRY\.launchGrantsWithoutValues\(\);/);
  assert.match(resume, /launchGrantUserId: null,/);
});

test("a consent change's replacement is granted for the runtime's own user, with a token read just before it starts", () => {
  const replace = functionBody("replaceDesktopRuntimeForConsentChange");
  // Only the runtime it replaces; nothing about the call that changed consent.
  assert.match(mainSource, /async function replaceDesktopRuntimeForConsentChange\(\s*previous: DesktopRuntimeRecord,\s*\)/);
  assert.match(
    replace,
    /resolveDesktopRuntimeLaunchGrants\(\{[^}]*instafyUserId: previous\.launchGrantUserId,[^}]*\}\)/,
  );
  assert.match(
    replace,
    /buildConsentChangeRestartOptions\(\{\s*restartOptions: previous\.restartOptions,\s*launchGrantUserId: previous\.launchGrantUserId,\s*currentSession,\s*\}\)/,
  );
  const stop = replace.indexOf("stopReplacedDesktopRuntime(previous)");
  const read = replace.indexOf("readStudioWindowSession()");
  const start = replace.indexOf("startDesktopRuntime({");
  assert.ok(stop >= 0 && read > stop && start > read, "the session is read after the stop, right before the start");
  assert.match(replace, /launchGrantUserId: previous\.launchGrantUserId,\s*launchGrants,/);

  const invoke = blockAfter('"instafy:desktopExtensionInvoke"');
  assert.match(invoke, /instafyUserId: runtime\.launchGrantUserId,/);
  assert.match(invoke, /replaceRuntime: \(runtime\) => replaceDesktopRuntimeForConsentChange\(runtime\.handle\),/);
  // A failed replacement is logged; the change it followed stays made.
  assert.match(invoke, /onReplaceError: \(error\) => \{/);
});

test("an extension call is keyed by the session the calling frame shows, never by its payload", () => {
  const resolveHost = functionBody("resolveDesktopExtensionHost");
  assert.match(resolveHost, /resolveVisibleSupabaseSession\(event\)/);
  assert.match(resolveHost, /userId: visibleIdentity\.userId\.toLowerCase\(\),/);
  const requestReads = [...resolveHost.matchAll(/\brequest(?:\?\.|\.)(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requestReads)], ["controllerUrl"]);
});

test("the preload declares the controller an extension call names", () => {
  const options = preloadSource.slice(
    preloadSource.indexOf("export type DesktopExtensionInvokeOptions = {"),
    preloadSource.indexOf("};", preloadSource.indexOf("export type DesktopExtensionInvokeOptions = {")),
  );
  assert.match(options, /\bcontrollerUrl\?: string;/);
});
