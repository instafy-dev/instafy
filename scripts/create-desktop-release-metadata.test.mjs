import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStableReleaseTransition,
  compareSemver,
  createDesktopReleaseManifest,
  createStableReleasePointer,
  parseStableReleasePointer,
} from "./create-desktop-release-metadata.mjs";

function stableManifest(version = "1.2.3", publishedAt = "2026-07-22T12:34:56.987Z") {
  return createDesktopReleaseManifest({
    version,
    tag: `desktop-app-v${version}`,
    channel: "stable",
    sourceSha: "a".repeat(40),
    publishedAt,
    feedUrl: "https://downloads.instafy.dev/desktop-app/stable/",
    macDmgName: `instafy-${version}-mac-arm64.dmg`,
    macZipName: `instafy-${version}-mac-arm64.zip`,
    windowsExeName: `instafy-${version}-win.exe`,
  });
}

test("creates deterministic strict stable metadata and a minimal atomic pointer", () => {
  const manifest = stableManifest();
  assert.equal(manifest.publishedAt, "2026-07-22T12:34:56Z");
  assert.equal(manifest.feedUrl, "https://downloads.instafy.dev/desktop-app/stable");
  assert.deepEqual(manifest.architectures, { mac: ["arm64"] });
  assert.deepEqual(createStableReleasePointer(manifest), {
    schemaVersion: 1,
    channel: "stable",
    tag: "desktop-app-v1.2.3",
    version: "1.2.3",
    sourceSha: "a".repeat(40),
    publishedAt: "2026-07-22T12:34:56Z",
  });
});

test("same-source reruns produce byte-identical immutable metadata", () => {
  const firstManifest = stableManifest("1.2.3", "2026-07-22T12:34:56.987Z");
  const rerunManifest = stableManifest("1.2.3", "2026-07-22T12:34:56.987Z");
  assert.equal(JSON.stringify(firstManifest), JSON.stringify(rerunManifest));
  assert.equal(
    JSON.stringify(createStableReleasePointer(firstManifest)),
    JSON.stringify(createStableReleasePointer(rerunManifest)),
  );
});

test("stable pointer parsing rejects legacy, extra, and path-injecting metadata", () => {
  const pointer = createStableReleasePointer(stableManifest());
  assert.throws(() => parseStableReleasePointer({ tag: pointer.tag, version: pointer.version }));
  assert.throws(() => parseStableReleasePointer({ ...pointer, surprise: true }));
  assert.throws(() => parseStableReleasePointer({ ...pointer, tag: "../../desktop-app-v1.2.3" }));
});

test("stable transitions are monotonic and byte-equivalent reruns are allowed", () => {
  const current = createStableReleasePointer(stableManifest("1.2.3"));
  const newer = createStableReleasePointer(stableManifest("1.3.0"));
  assert.deepEqual(assertStableReleaseTransition(current, current), current);
  assert.deepEqual(assertStableReleaseTransition(current, newer), newer);
  assert.throws(
    () => assertStableReleaseTransition(newer, current),
    /Refusing to move stable from 1\.3\.0 to non-newer 1\.2\.3/,
  );
  assert.throws(
    () =>
      assertStableReleaseTransition(current, {
        ...current,
        sourceSha: "b".repeat(40),
      }),
    /non-newer 1\.2\.3/,
  );
});

test("SemVer precedence handles prereleases and ignores build metadata", () => {
  assert.equal(compareSemver("1.2.3-rc.2", "1.2.3-rc.10"), -1);
  assert.equal(compareSemver("1.2.3", "1.2.3-rc.10"), 1);
  assert.equal(compareSemver("2.0.0+build.2", "2.0.0+build.1"), 0);
  assert.throws(() => compareSemver("1.2.3-01", "1.2.3-1"), /Invalid SemVer/);
});

test("rejects channel-incompatible artifacts and mismatched stable tags", () => {
  assert.throws(
    () => createStableReleasePointer({ ...stableManifest(), channel: "internal" }),
    /Only a stable manifest/,
  );
  assert.throws(
    () =>
      createDesktopReleaseManifest({
        ...stableManifest(),
        tag: "desktop-app-v1.2.4",
        macDmgName: "instafy-1.2.3-mac-arm64.dmg",
        macZipName: "instafy-1.2.3-mac-arm64.zip",
        windowsExeName: "instafy-1.2.3-win.exe",
      }),
    /stable tag must exactly match/,
  );
  assert.throws(
    () => stableManifest("1.2.3+signed.1"),
    /must not use SemVer build metadata/,
  );
  assert.throws(() => stableManifest("1.2.3-01"), /Invalid SemVer/);
});

test("a macOS-only release omits the Windows artifact instead of failing", () => {
  // Windows builds need a code-signing certificate no CA has issued in an
  // exportable form since June 2023, so a release may legitimately contain
  // macOS alone. Requiring windowsExeName here made such a release
  // unpublishable rather than simply Windows-less.
  const version = "1.2.3";
  const manifest = createDesktopReleaseManifest({
    version,
    tag: `desktop-app-v${version}`,
    channel: "stable",
    sourceSha: "a".repeat(40),
    publishedAt: "2026-07-22T12:34:56.987Z",
    feedUrl: "https://downloads.instafy.dev/desktop-app/stable/",
    macDmgName: `instafy-${version}-mac-arm64.dmg`,
    macZipName: `instafy-${version}-mac-arm64.zip`,
  });
  assert.equal(manifest.artifacts.windowsExe, undefined);
  assert.ok(manifest.artifacts.macDmg.endsWith(`instafy-${version}-mac-arm64.dmg`));
  assert.ok(manifest.artifacts.macZip.endsWith(`instafy-${version}-mac-arm64.zip`));
  assert.deepEqual(manifest.architectures, { mac: ["arm64"] });
});

test("an included Windows artifact is still validated strictly", () => {
  // Optional must not mean unchecked: a present-but-wrong Windows name is a
  // mismatched release, and still has to fail.
  assert.throws(
    () =>
      createDesktopReleaseManifest({
        version: "1.2.3",
        tag: "desktop-app-v1.2.3",
        channel: "stable",
        sourceSha: "a".repeat(40),
        publishedAt: "2026-07-22T12:34:56.987Z",
        feedUrl: "https://downloads.instafy.dev/desktop-app/stable/",
        macDmgName: "instafy-1.2.3-mac-arm64.dmg",
        macZipName: "instafy-1.2.3-mac-arm64.zip",
        windowsExeName: "instafy-9.9.9-win.exe",
      }),
    /Windows artifact must name the release version/u,
  );
});
