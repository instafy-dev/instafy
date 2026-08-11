import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, "..", "useNativeGithubAuth.ts");
const source = fs.readFileSync(HOOK_PATH, "utf8");

/**
 * Desktop OAuth returns through an Electron IPC transport that shares the
 * `instafy://auth` callback with the Capacitor native builds, but none of the
 * Capacitor plugins exist under Electron.
 *
 * These are source invariants rather than behavioural assertions on purpose.
 * The bug they guard (shipped in 0.2.5) was not wrong logic -- the desktop
 * wiring was correct and simply unreachable, sitting after an effect-level
 * `return` taken whenever the Capacitor plugins were missing, which is always
 * the case on desktop. The shell parked the callback, nothing collected it,
 * and sign-in hung on "Finish signing in with GitHub in your browser...".
 * A unit test of the wiring function would have passed the whole time.
 */
describe("desktop auth callback wiring reachability", () => {
  const desktopWiringIndex = source.indexOf("desktopCanReceiveAuthCallback()");

  it("wires the desktop transport at all", () => {
    expect(desktopWiringIndex).toBeGreaterThan(-1);
    expect(source).toContain("onDesktopAuthCallback(");
    expect(source).toContain("consumeDesktopAuthCallback(");
  });

  it("does not gate the effect on Capacitor plugins being present", () => {
    // The exact shape that broke it: a bare early return keyed on plugin
    // absence, evaluated before the desktop transport is wired.
    const pluginEarlyReturn = /if\s*\(\s*!\s*appPlugin\s*\|\|\s*!\s*nativeAuthBridgePlugin\s*\)\s*\{\s*return\s*;?\s*\}/;
    expect(source).not.toMatch(pluginEarlyReturn);
  });

  it("does not bail out of the effect on a non-native Capacitor platform", () => {
    // Electron is a *web* platform to Capacitor, so `!isNativePlatform()` is
    // true in the desktop shell. This guard sits one level above the plugin
    // check and was the outer half of the same bug: every `isNativePlatform`
    // bail-out preceding the desktop wiring must also allow a desktop
    // callback through.
    const effectStart = source.lastIndexOf("useEffect(() => {", desktopWiringIndex);
    const beforeWiring = source.slice(effectStart, desktopWiringIndex);
    for (const match of beforeWiring.matchAll(/if\s*\(([^)]*isNativePlatform\(\)[^{]*)\)\s*\{\s*return/g)) {
      expect(match[1]).toMatch(/[Dd]esktop/);
    }
  });

  it("reaches the desktop transport before any Capacitor-only bail-out", () => {
    // Any bail-out that mentions the native plugins must come after the
    // desktop wiring, so a missing Capacitor runtime can never skip it.
    const bailOuts = [...source.matchAll(/nativePluginsAvailable[\s\S]{0,120}?return\s*;/g)].map(
      (match) => match.index ?? -1,
    );
    for (const bailOut of bailOuts) {
      expect(bailOut).toBeGreaterThan(desktopWiringIndex);
    }
  });

  it("clears the parked callback after a live delivery", () => {
    // The shell parks every callback *and* sends it. Without this the copy
    // outlives a successful sign-in and the next mount replays a spent token.
    const listenerBlock = source.slice(
      source.indexOf("onDesktopAuthCallback("),
      source.indexOf("onDesktopAuthCallback(") + 600,
    );
    expect(listenerBlock).toContain("consumeDesktopAuthCallback()");
  });
});
