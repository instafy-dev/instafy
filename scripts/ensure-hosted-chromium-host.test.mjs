import assert from "node:assert/strict";
import test from "node:test";
import { APT_OPTIONS, assertHostedUbuntu, assertReviewedTable, ensureHostedChromiumHost, HOSTED_PACKAGES, installMissing,
  missingPackages, OMITTED_FONTS, PLAYWRIGHT_CHROMIUM, PLAYWRIGHT_TOOLS, playwrightTable, verifyHost } from "./ensure-hosted-chromium-host.mjs";

const ubuntu = 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nVERSION_ID="24.04"\n';
const hosted = { env: { RUNNER_ENVIRONMENT: "github-hosted" }, platform: "linux", arch: "x64", readOsRelease: () => ubuntu };
// The exact shape of the table in playwright-core's lib/coreBundle.js.
const bundle = (tools = PLAYWRIGHT_TOOLS, chromium = PLAYWRIGHT_CHROMIUM) => `      "ubuntu22.04-x64": {}\n      "ubuntu24.04-x64": {\n        tools: [\n${
  tools.map(name => `          "${name}"`).join(",\n")}\n        ],\n        chromium: [\n${chromium.map(name => `          "${name}"`).join(",\n")}\n        ],\n        firefox: [\n`;
const chrome = "/home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
const shell = "/home/runner/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
const ldd = "\tlibnss3.so => /lib/x86_64-linux-gnu/libnss3.so (0x1)\n\tlibgbm.so.1 => /lib/x86_64-linux-gnu/libgbm.so.1 (0x2)";
// A fake host whose dpkg database is `installed`; a successful apt install adds its arguments.
function fakeHost({ installed = HOSTED_PACKAGES, libraries = () => ldd, aptInstalls = true, ...overrides } = {}) {
  const calls = [], logs = [], database = new Set(installed);
  const host = { ...hosted, readPlaywrightBundle: () => { calls.push(["read bundle"]); return bundle(); },
    lockedExecutables: () => [chrome, shell], log: message => logs.push(message),
    exec(file, args) {
      calls.push([file, args]);
      if (file === "ldd") return libraries(args[0]);
      assert.equal(file, "dpkg-query");
      assert.deepEqual(args.slice(0, 2), ["--show", "--showformat=${Status}"]);
      if (!database.has(args[2])) throw new Error(`dpkg-query: no packages found matching ${args[2]}`);
      return "install ok installed";
    },
    run(file, args) {
      calls.push([file, args]);
      if (aptInstalls && args.includes("install")) for (const name of args.slice(args.indexOf("--no-upgrade") + 1)) database.add(name);
    },
    ...overrides };
  return { host, calls, logs };
}
const apt = calls => calls.filter(([file]) => file === "sudo");

test("the hosted list is Playwright's locked Chromium table minus only reviewed glyph-coverage fonts", () => {
  assert.equal(PLAYWRIGHT_TOOLS.length, 12);
  assert.equal(PLAYWRIGHT_CHROMIUM.length, 21);
  assert.equal(HOSTED_PACKAGES.length, 26);
  assert.equal(new Set(HOSTED_PACKAGES).size, HOSTED_PACKAGES.length);
  assert.deepEqual([...HOSTED_PACKAGES, ...OMITTED_FONTS].sort(), [...PLAYWRIGHT_CHROMIUM, ...PLAYWRIGHT_TOOLS].sort());
  for (const name of OMITTED_FONTS) assert.ok(PLAYWRIGHT_TOOLS.includes(name) && /^x?fonts-/u.test(name), name);
  for (const name of ["xvfb", "libfontconfig1", "libfreetype6", "fonts-liberation", "fonts-noto-color-emoji", ...PLAYWRIGHT_CHROMIUM])
    assert.ok(HOSTED_PACKAGES.includes(name), name);
  assert.deepEqual(APT_OPTIONS, ["-o", "Acquire::Retries=2", "-o", "Acquire::http::Timeout=30", "-o", "Acquire::https::Timeout=30"]);
});

test("a locked table that adds any unreviewed package fails; one that drops a package passes", () => {
  assert.deepEqual(playwrightTable(bundle()), { tools: [...PLAYWRIGHT_TOOLS], chromium: [...PLAYWRIGHT_CHROMIUM] });
  assertReviewedTable(playwrightTable(bundle()));
  for (const removed of [bundle(PLAYWRIGHT_TOOLS.filter(name => name !== "fonts-unifont")), bundle(PLAYWRIGHT_TOOLS, PLAYWRIGHT_CHROMIUM.slice(1)),
    bundle(PLAYWRIGHT_TOOLS.filter(name => !OMITTED_FONTS.includes(name)))]) assertReviewedTable(playwrightTable(removed));
  for (const added of [bundle([...PLAYWRIGHT_TOOLS, "fonts-new"]), bundle(PLAYWRIGHT_TOOLS, [...PLAYWRIGHT_CHROMIUM, "libnew1"]),
    // An omitted font that Chromium itself starts requiring needs review too.
    bundle(PLAYWRIGHT_TOOLS, [...PLAYWRIGHT_CHROMIUM, "fonts-unifont"])])
    assert.throws(() => assertReviewedTable(playwrightTable(added)), /re-review HOSTED_PACKAGES and OMITTED_FONTS/u);
  for (const unparsable of [bundle().replace("ubuntu24.04-x64", "ubuntu26.04-x64"), bundle().replace("tools:", "utilities:"),
    bundle().replace('"libnss3"', "libnss3"), bundle().replace('"xvfb",', '...extra, "xvfb",'), bundle([], PLAYWRIGHT_CHROMIUM),
    bundle(PLAYWRIGHT_TOOLS, []), ""]) assert.throws(() => playwrightTable(unparsable), /re-review/u);
});

test("only a GitHub-hosted Ubuntu 24.04 x64 runner may use the hosted list, and the runner type is checked first", () => {
  assertHostedUbuntu(hosted);
  for (const env of [{ RUNNER_ENVIRONMENT: "self-hosted" }, {}, { RUNNER_ENVIRONMENT: "" }, { RUNNER_ENVIRONMENT: "GitHub-Hosted" }]) {
    let read = false;
    assert.throws(() => assertHostedUbuntu({ ...hosted, env, readOsRelease: () => { read = true; return ubuntu; } }));
    assert.equal(read, false, JSON.stringify(env));
    // Neither the Playwright bundle nor dpkg nor apt is consulted on such a runner.
    const { host, calls } = fakeHost({ env });
    assert.throws(() => ensureHostedChromiumHost("install", host));
    assert.deepEqual(calls, []);
  }
  for (const changed of [{ arch: "arm64" }, { platform: "darwin" }, { readOsRelease: () => ubuntu.replace('VERSION_ID="24.04"', 'VERSION_ID="22.04"') },
    { readOsRelease: () => ubuntu.replace("ID=ubuntu", "ID=debian") }, { readOsRelease: () => { throw new Error("ENOENT"); } }])
    assert.throws(() => assertHostedUbuntu({ ...hosted, ...changed }));
  for (const mode of [undefined, "", "upgrade", "install-deps"]) {
    const { host, calls } = fakeHost();
    assert.throws(() => ensureHostedChromiumHost(mode, host), /usage/u);
    assert.deepEqual(calls, []);
  }
});

test("a complete image downloads nothing and still verifies both locked executables", () => {
  for (const mode of ["install", "verify"]) {
    const { host, calls, logs } = fakeHost();
    ensureHostedChromiumHost(mode, host);
    assert.deepEqual(apt(calls), []);
    assert.deepEqual(calls.filter(([file]) => file === "ldd"), [["ldd", [chrome]], ["ldd", [shell]]]);
    assert.equal(calls.filter(([file]) => file === "dpkg-query").length, (mode === "install" ? 2 : 1) * HOSTED_PACKAGES.length);
    assert.match(logs.at(-1), /^verified 26 packages and every shared library of /u);
    if (mode === "install") assert.match(logs[0], /nothing to download/u);
  }
});

test("image drift installs only the missing reviewed packages, without upgrades, through the exact apt argv", () => {
  const { host, calls, logs } = fakeHost({ installed: HOSTED_PACKAGES.filter(name => name !== "libgbm1" && name !== "xvfb") });
  ensureHostedChromiumHost("install", host);
  assert.deepEqual(apt(calls), [
    ["sudo", ["-n", "apt-get", ...APT_OPTIONS, "update"]],
    ["sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", ...APT_OPTIONS, "install", "--yes", "--no-install-recommends", "--no-upgrade", "libgbm1", "xvfb"]],
  ]);
  assert.match(logs.join("\n"), /installing only: libgbm1 xvfb\n.*installed 2 packages missing from the hosted image: libgbm1 xvfb/u);
  // Verify mode never installs; it fails on the same gap instead.
  const verifyOnly = fakeHost({ installed: HOSTED_PACKAGES.slice(1) });
  assert.throws(() => ensureHostedChromiumHost("verify", verifyOnly.host), /missing after installation: libasound2t64/u);
  assert.deepEqual(apt(verifyOnly.calls), []);
  for (const names of [["fonts-wqy-zenhei"], ["libgbm1", "cmake"], ["--allow-downgrades"]])
    assert.throws(() => installMissing(names, () => assert.fail("apt must not run"), () => {}), /refusing/u);
});

test("verification fails closed on a package apt did not install or an unloadable Chromium library", () => {
  const unchanged = fakeHost({ installed: HOSTED_PACKAGES.slice(1), aptInstalls: false });
  assert.throws(() => ensureHostedChromiumHost("install", unchanged.host), /missing after installation: libasound2t64/u);
  const aptFails = fakeHost({ installed: HOSTED_PACKAGES.slice(1), run: () => { throw new Error("E: Unable to fetch some archives"); } });
  assert.throws(() => ensureHostedChromiumHost("install", aptFails.host), /Unable to fetch/u);
  for (const libraries of [executable => executable === shell ? `${ldd}\n\tlibnew.so.1 => not found` : ldd,
    executable => executable === chrome ? `${ldd}\n\tlibnew.so.1 => not found` : ldd,
    () => "\tlibgbm.so.1 => /lib/x86_64-linux-gnu/libgbm.so.1 (0x2)", () => "\tnot a dynamic executable",
    () => { throw new Error("ldd: exited with 1"); }])
    assert.throws(() => ensureHostedChromiumHost("verify", fakeHost({ libraries }).host));
  for (const executables of [[], [chrome, undefined], ["chrome-linux64/chrome", shell]])
    assert.throws(() => ensureHostedChromiumHost("verify", fakeHost({ lockedExecutables: () => executables }).host));
  const exec = fakeHost().host.exec;
  verifyHost({ executables: [chrome, shell], exec });
  assert.deepEqual(missingPackages(HOSTED_PACKAGES, exec), []);
});
