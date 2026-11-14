import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Desktop's side of local-engine turns (docs/Local-Engine-Turns.md, 4.1-4.5).
// No test here runs a real claude: the "program" is an empty file that is
// only ever looked at, and every login shell is a fake script.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const registry = require(path.join(packageRoot, "dist/desktopExtensionRegistry.js"));
const trust = require(path.join(packageRoot, "dist/desktopControllerTrust.js"));

// The module has no build entry of its own, so load its TypeScript sources
// the way personal-browser-agent-tabs.test.mjs loads personalBrowserHost.ts.
const loadedSources = new Map();
function loadSource(file) {
  const cached = loadedSources.get(file);
  if (cached) {
    return cached.exports;
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  loadedSources.set(file, module);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) {
      return require(specifier);
    }
    const base = path.resolve(path.dirname(file), specifier);
    for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
      if (fs.existsSync(candidate)) {
        return loadSource(candidate);
      }
    }
    throw new Error(`Cannot resolve ${specifier} from ${file}`);
  };
  vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${outputText}\n})`,
    { filename: file },
  )(module.exports, localRequire, module, file, path.dirname(file));
  return module.exports;
}

const claudeCode = loadSource(path.join(packageRoot, "src/claudeCode/index.ts"));
const detection = loadSource(path.join(packageRoot, "src/claudeCode/detect.ts"));
const validation = loadSource(path.join(packageRoot, "src/claudeCode/validate.ts"));
const consent = loadSource(path.join(packageRoot, "src/claudeCode/consent.ts"));

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTROLLER = "https://controller.instafy.dev";
// Only ever a key here; nothing contacts it.
const OTHER_CONTROLLER = "http://127.0.0.1:18788";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROXY_WITH_PASSWORD = "http://person:proxy-password@proxy.corp.example:3128";
const NOW = new Date("2026-11-13T12:00:00.000Z");
const GRANT_KEYS = [
  "INSTAFY_CLAUDE_CODE_BIN",
  "INSTAFY_CLAUDE_CODE_PATH",
  "INSTAFY_CLAUDE_CODE_USER_ID",
  "INSTAFY_CLAUDE_CODE_ENV_JSON",
];
// Every key a method may answer with: the shape Studio parses
// (packages/frontend/src/features/claudeCode/claudeCodeDesktop.ts).
const STATUS_KEYS = [
  "supported",
  "found",
  "path",
  "consented",
  "problem",
  "candidatePath",
  "candidateProblem",
  "shellSetting",
];

const tempRoots = [];
after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-claude-code-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const otherBinDir = path.join(root, "other-bin");
  const shellDir = path.join(root, "shells");
  const workspace = path.join(root, "workspace");
  for (const dir of [home, binDir, otherBinDir, shellDir, workspace]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
  }
  // Stand-ins that are only ever looked at, never run.
  const claude = path.join(binDir, "claude");
  writeExecutable(claude, "#!/bin/sh\nexit 0\n");
  const otherClaude = path.join(otherBinDir, "claude");
  writeExecutable(otherClaude, "#!/bin/sh\nexit 0\n");
  // The places the login shells name for CLAUDE_CONFIG_DIR and
  // NODE_EXTRA_CA_CERTS (D26): only this user can change the first two.
  const configDir = path.join(home, ".claude-work");
  fs.mkdirSync(configDir);
  fs.chmodSync(configDir, 0o700);
  const caFile = path.join(home, "corp-ca.pem");
  fs.writeFileSync(caFile, "fixture CA bundle\n");
  fs.chmodSync(caFile, 0o644);
  // Where a test moves the CA file; nothing is there at first.
  const movedCaFile = path.join(home, "corp-ca-renewed.pem");
  const sharedConfigDir = path.join(home, ".claude-shared");
  fs.mkdirSync(sharedConfigDir);
  fs.chmodSync(sharedConfigDir, 0o775);

  const envDump = path.join(root, "shell-env.txt");
  const cwdDump = path.join(root, "shell-cwd.txt");
  const sleeperPid = path.join(root, "sleeper.pid");
  // A quiet login shell whose PATH starts at `pathDir`, with these exports.
  const findingShell = (pathDir, exports) =>
    [
      "#!/bin/bash",
      `export PATH=${JSON.stringify(`${pathDir}:/usr/bin:/bin`)}`,
      ...Object.entries(exports).map(([key, value]) => `export ${key}=${value}`),
      'eval "$2"',
    ].join("\n");
  // A quiet login shell where `command -v` prints an alias, not a path, with these exports.
  const aliasShell = (pathValue, exports) =>
    [
      "#!/bin/bash",
      `export PATH=${JSON.stringify(pathValue)}`,
      ...Object.entries(exports).map(([key, value]) => `export ${key}=${value}`),
      "shopt -s expand_aliases",
      "alias claude='~/.claude/local/claude'",
      'eval "$2"',
    ].join("\n");
  const shells = {
    // A noisy login shell that finds the program and has all five D26 values.
    found: [
      "#!/bin/bash",
      'echo "Last login: Thu Nov 13 09:00:00 on ttys001"',
      // A forged marker without this run's nonce, and a forged value.
      'echo "<<instafy-detect-0123456789abcdef-bin>>"',
      'echo "/tmp/forged/claude"',
      "printf '\\033[32mnvm ready\\033[0m\\n'",
      `/usr/bin/env > ${JSON.stringify(envDump)}`,
      `pwd > ${JSON.stringify(cwdDump)}`,
      `export PATH=${JSON.stringify(`${binDir}:relative/bin:/usr/bin:/bin:/usr/bin`)}`,
      `export CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)}`,
      `export HTTPS_PROXY=${JSON.stringify(PROXY_WITH_PASSWORD)}`,
      'export HTTP_PROXY="http://proxy.corp.example:3128"',
      'export NO_PROXY="localhost,.corp.example"',
      `export NODE_EXTRA_CA_CERTS=${JSON.stringify(caFile)}`,
      'export UNRELATED_SECRET="never-printed"',
      'eval "$2"',
      'echo "Saving session... completed."',
    ].join("\n"),
    // The same values, with another program first on PATH.
    foundOther: findingShell(otherBinDir, {
      CLAUDE_CONFIG_DIR: JSON.stringify(configDir),
      NODE_EXTRA_CA_CERTS: JSON.stringify(caFile),
    }),
    // A quoted tilde stays as it is: not a full path.
    relativeConfig: findingShell(binDir, { CLAUDE_CONFIG_DIR: '"~/.claude-work"' }),
    // A configuration folder its group can change.
    sharedConfig: findingShell(binDir, { CLAUDE_CONFIG_DIR: JSON.stringify(sharedConfigDir) }),
    // A CA bundle that is not there any more.
    missingCa: findingShell(binDir, {
      NODE_EXTRA_CA_CERTS: JSON.stringify(path.join(home, "deleted-ca.pem")),
    }),
    // The same program, once the person stops exporting a CA bundle.
    configOnly: findingShell(binDir, { CLAUDE_CONFIG_DIR: JSON.stringify(configDir) }),
    // The same program and values as `found`, the CA bundle at its new place.
    movedCa: findingShell(binDir, {
      CLAUDE_CONFIG_DIR: JSON.stringify(configDir),
      HTTPS_PROXY: JSON.stringify(PROXY_WITH_PASSWORD),
      HTTP_PROXY: '"http://proxy.corp.example:3128"',
      NO_PROXY: '"localhost,.corp.example"',
      NODE_EXTRA_CA_CERTS: JSON.stringify(movedCaFile),
    }),
    // Another program, with a configuration folder its group can change.
    otherSharedConfig: findingShell(otherBinDir, {
      CLAUDE_CONFIG_DIR: JSON.stringify(sharedConfigDir),
    }),
    // `command -v` prints an alias, not a path.
    alias: [
      "#!/bin/bash",
      'echo "Welcome!"',
      'export PATH="/usr/bin:/bin"',
      "shopt -s expand_aliases",
      "alias claude='~/.claude/local/claude'",
      'eval "$2"',
    ].join("\n"),
    // ... and a shell function's bare name.
    function: [
      "#!/bin/bash",
      'export PATH="/usr/bin:/bin"',
      'claude() { echo "never run"; }',
      'eval "$2"',
    ].join("\n"),
    // An alias, with the two values that name a place (D26).
    aliasValues: aliasShell("/usr/bin:/bin", {
      CLAUDE_CONFIG_DIR: JSON.stringify(configDir),
      NODE_EXTRA_CA_CERTS: JSON.stringify(caFile),
    }),
    // The same alias once the person stops exporting a CA bundle, with a folder added to PATH.
    aliasConfigOnly: aliasShell("/opt/corp-tools/bin:/usr/bin:/bin", {
      CLAUDE_CONFIG_DIR: JSON.stringify(configDir),
    }),
    // The same alias, with a configuration folder its group can change.
    aliasSharedConfig: aliasShell("/usr/bin:/bin", {
      CLAUDE_CONFIG_DIR: JSON.stringify(sharedConfigDir),
    }),
    // A shell that ignores its command: no markers at all.
    noMarkers: ["#!/bin/bash", 'echo "this shell ignores -c"', "exit 0"].join("\n"),
    // Hangs past the timeout, with a background job in its group.
    slow: [
      "#!/bin/bash",
      "/bin/sleep 30 &",
      `echo $! > ${JSON.stringify(sleeperPid)}`,
      "/bin/sleep 30",
    ].join("\n"),
    // Prints more than the output cap before its answer.
    chatty: [
      "#!/bin/bash",
      "/usr/bin/head -c 200000 /dev/zero | /usr/bin/tr '\\0' 'x'",
      'eval "$2"',
    ].join("\n"),
    unlisted: ["#!/bin/bash", 'eval "$2"'].join("\n"),
  };
  const shellPaths = {};
  for (const [name, script] of Object.entries(shells)) {
    shellPaths[name] = path.join(shellDir, name);
    writeExecutable(shellPaths[name], `${script}\n`);
  }
  const etcShells = path.join(root, "etc-shells");
  fs.writeFileSync(
    etcShells,
    [
      "# List of acceptable shells",
      ...Object.entries(shellPaths)
        .filter(([name]) => name !== "unlisted")
        .map(([, file]) => file),
      "",
    ].join("\n"),
  );
  return {
    root,
    home,
    binDir,
    otherBinDir,
    claude,
    otherClaude,
    configDir,
    caFile,
    movedCaFile,
    sharedConfigDir,
    workspace,
    shells: shellPaths,
    etcShells,
    envDump,
    cwdDump,
    sleeperPid,
  };
}

// The module's file system, except that the usual install locations outside
// the fixture never exist, whatever this computer has there.
const hermeticFs = {
  lstatSync(file) {
    if (file === "/opt/homebrew/bin/claude" || file === "/usr/local/bin/claude") {
      throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
    }
    return fs.lstatSync(file);
  },
  readlinkSync: (file) => fs.readlinkSync(file),
  realpathSync: (file) => fs.realpathSync(file),
  accessSync: (file, mode) => fs.accessSync(file, mode),
};

function shellOptions(fixture, shell, overrides = {}) {
  return {
    shell,
    homeDir: fixture.home,
    user: "fixture-user",
    lang: "en_US.UTF-8",
    etcShellsPath: fixture.etcShells,
    // Detect's own limit: a loaded machine can take seconds to start a
    // login shell, and no test here waits for it to run out.
    timeoutMs: detection.CLAUDE_CODE_DETECT_TIMEOUT_MS,
    // Never the real ~/.local/bin, /opt/homebrew/bin or /usr/local/bin.
    lstat: () => {
      throw Object.assign(new Error("not here"), { code: "ENOENT" });
    },
    ...overrides,
  };
}

function memoryConsents(initial = {}) {
  let data = structuredClone(initial);
  return {
    read: () => structuredClone(data),
    write: (next) => {
      data = structuredClone(next);
    },
  };
}

function fakeDialogs({ answer = 0, pick = null } = {}) {
  const dialogs = {
    shown: [],
    picks: 0,
    answer,
    pick,
    async showMessageBox(options) {
      dialogs.shown.push(options);
      return dialogs.answer;
    },
    async pickFile() {
      dialogs.picks += 1;
      return dialogs.pick;
    },
  };
  return dialogs;
}

function hostFor({
  userId = USER_A,
  email = "person-a@example.test",
  controllerOrigin = CONTROLLER,
  consents,
  dialogs = fakeDialogs(),
  desktopOwnedPaths = [],
} = {}) {
  return {
    session: userId ? { userId, email } : null,
    controllerOrigin,
    consents,
    dialogs,
    desktopOwnedPaths,
  };
}

function createModule(fixture, overrides = {}) {
  return claudeCode.createClaudeCodeDesktopFeatureModule({
    platform: "darwin",
    fs: hermeticFs,
    adminGroupId: null,
    osAccount: () => ({ username: "fixture-user", homedir: fixture.home, shell: fixture.shells.found }),
    lang: () => "en_US.UTF-8",
    etcShellsPath: fixture.etcShells,
    detectTimeoutMs: detection.CLAUDE_CODE_DETECT_TIMEOUT_MS,
    now: () => NOW,
    ...overrides,
  });
}

function setup(overrides = {}) {
  const fixture = makeFixture();
  const consents = memoryConsents();
  // The person's login shell, which a test can change between calls.
  let loginShell = fixture.shells.found;
  const extensions = registry.createDesktopExtensionRegistry([
    createModule(fixture, {
      osAccount: () => ({ username: "fixture-user", homedir: fixture.home, shell: loginShell }),
      ...overrides,
    }),
  ]);
  const invoke = (method, host, payload = {}) =>
    extensions.invoke(claudeCode.CLAUDE_CODE_DESKTOP_EXTENSION_ID, method, payload, host);
  const grantFor = async (instafyUserId, controllerOrigin = CONTROLLER) => {
    const [entry] = await extensions.resolveLaunchGrants({
      projectId: PROJECT_ID,
      controllerOrigin,
      instafyUserId,
      consents,
    });
    return entry.grant;
  };
  const useShell = (name) => {
    loginShell = fixture.shells[name];
  };
  return { fixture, consents, extensions, invoke, grantFor, useShell };
}

async function consentAs(context, host) {
  await context.invoke("detect", host);
  return await context.invoke("enable", host);
}

// A consent record as Use for my messages writes it, for a test whose login
// shells need not answer.
function writeConsentRecord(context, record) {
  registry
    .createDesktopExtensionConsentStore(context.consents, {
      moduleId: claudeCode.CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID,
      controllerOrigin: CONTROLLER,
      userId: USER_A,
    })
    .write({ consentedAt: NOW.toISOString(), osUser: "fixture-user", ...record });
}

// The consent dialog's whole text: the design's, then what it lists (4.2).
const consentDetail = (...listed) => [consent.CLAUDE_CODE_CONSENT_TEXT, ...listed].join("\n\n");

// ---------------------------------------------------------------- detection

test("detection reads the program, PATH and the five D26 values between this run's markers", async () => {
  const fixture = makeFixture();
  process.env.INSTAFY_DETECT_CANARY = "inherited";
  try {
    const found = await detection.detectClaudeCode(shellOptions(fixture, fixture.shells.found));
    assert.equal(found.binaryPath, fixture.claude);
    assert.equal(found.source, "login_shell");
    assert.equal(found.shellAnswered, true);
    // Absolute entries only, in order, without duplicates.
    assert.deepEqual(found.pathEntries, [fixture.binDir, "/usr/bin", "/bin"]);
    assert.deepEqual(found.env, {
      CLAUDE_CONFIG_DIR: path.join(fixture.home, ".claude-work"),
      HTTPS_PROXY: PROXY_WITH_PASSWORD,
      HTTP_PROXY: "http://proxy.corp.example:3128",
      NO_PROXY: "localhost,.corp.example",
      NODE_EXTRA_CA_CERTS: path.join(fixture.home, "corp-ca.pem"),
    });
    assert.equal(JSON.stringify(found).includes("never-printed"), false);
  } finally {
    delete process.env.INSTAFY_DETECT_CANARY;
  }

  // The shell got a minimal environment and the home folder as its cwd.
  const shellEnv = Object.fromEntries(
    fs
      .readFileSync(fixture.envDump, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  assert.equal(shellEnv.HOME, fixture.home);
  assert.equal(shellEnv.USER, "fixture-user");
  assert.equal(shellEnv.SHELL, fixture.shells.found);
  assert.equal(shellEnv.LANG, "en_US.UTF-8");
  assert.equal(shellEnv.INSTAFY_DETECT_CANARY, undefined);
  for (const key of Object.keys(shellEnv)) {
    assert.ok(
      ["HOME", "USER", "SHELL", "LANG", "PWD", "OLDPWD", "SHLVL", "_"].includes(key),
      `the login shell inherited ${key}`,
    );
  }
  assert.equal(fs.readFileSync(fixture.cwdDump, "utf8").trim(), fixture.home);
});

test("an alias or a shell function is not a path, and missing markers count as no answer", async () => {
  const fixture = makeFixture();
  for (const shell of [fixture.shells.alias, fixture.shells.function]) {
    const report = await detection.runClaudeCodeLoginShell(shellOptions(fixture, shell));
    assert.ok(report, "the shell answered");
    assert.equal(report.binaryPath, null);
    assert.deepEqual(report.pathEntries, ["/usr/bin", "/bin"]);
    const result = await detection.detectClaudeCode(shellOptions(fixture, shell));
    assert.equal(result.binaryPath, null);
    assert.equal(result.source, null);
    // It answered, naming no program, so its PATH and values count.
    assert.equal(result.shellAnswered, true);
    assert.deepEqual(result.pathEntries, ["/usr/bin", "/bin"]);
  }

  assert.equal(
    await detection.runClaudeCodeLoginShell(shellOptions(fixture, fixture.shells.noMarkers)),
    null,
  );
  // Then only the usual install locations are looked at.
  const fallback = await detection.detectClaudeCode(
    shellOptions(fixture, fixture.shells.noMarkers, {
      lstat: (file) => {
        if (file === path.join(fixture.home, ".local", "bin", "claude")) {
          return { isFile: () => false, isSymbolicLink: () => true };
        }
        throw Object.assign(new Error("not here"), { code: "ENOENT" });
      },
    }),
  );
  assert.equal(fallback.binaryPath, path.join(fixture.home, ".local", "bin", "claude"));
  assert.equal(fallback.source, "candidate");
  // Its empty PATH and values are not the shell's: it gave no answer.
  assert.equal(fallback.shellAnswered, false);
  assert.deepEqual(fallback.pathEntries, []);
  assert.deepEqual(fallback.env, {});
});

test("a shell /etc/shells does not list is never run", async () => {
  const fixture = makeFixture();
  assert.equal(
    await detection.runClaudeCodeLoginShell(shellOptions(fixture, fixture.shells.unlisted)),
    null,
  );
  assert.equal(
    await detection.runClaudeCodeLoginShell(shellOptions(fixture, "bash")),
    null,
  );
  assert.equal(detection.isListedLoginShell("/bin/zsh", "# comment\n/bin/zsh\n"), true);
  assert.equal(detection.isListedLoginShell("/bin/zsh", "# /bin/zsh\n/bin/bash\n"), false);
});

test("detection stops a shell that runs past its timeout, with its process group", async () => {
  const fixture = makeFixture();
  const started = Date.now();
  // Long enough for the fake shell to start its background job on a busy
  // machine, far shorter than the job itself.
  const report = await detection.runClaudeCodeLoginShell(
    shellOptions(fixture, fixture.shells.slow, { timeoutMs: 2_500 }),
  );
  assert.equal(report, null);
  assert.ok(Date.now() - started < 10_000);
  const sleeper = Number(fs.readFileSync(fixture.sleeperPid, "utf8").trim());
  const deadline = Date.now() + 2_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(sleeper, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the shell's background job is stopped too");
});

test("detection refuses output past its cap", async () => {
  const fixture = makeFixture();
  assert.equal(
    await detection.runClaudeCodeLoginShell(
      shellOptions(fixture, fixture.shells.chatty, { outputCapBytes: 64 * 1024 }),
    ),
    null,
  );
});

test("parsing keeps only values between this run's own markers", () => {
  const nonce = "feedfacecafebeef";
  const marker = (name) => `<<instafy-detect-${nonce}-${name}>>`;
  const output = [
    "noise before",
    "<<instafy-detect-0000000000000000-begin>>",
    marker("begin"),
    marker("bin"),
    "/opt/homebrew/bin/claude",
    marker("PATH"),
    "/opt/homebrew/bin:./node_modules/.bin:/usr/bin",
    marker("CLAUDE_CONFIG_DIR"),
    "line one",
    "line two",
    marker("HTTPS_PROXY"),
    marker("end"),
    "noise after",
  ].join("\r\n");
  assert.deepEqual(detection.parseClaudeCodeDetectOutput(output, nonce), {
    binaryPath: "/opt/homebrew/bin/claude",
    pathEntries: ["/opt/homebrew/bin", "/usr/bin"],
    env: {},
  });
  assert.equal(detection.parseClaudeCodeDetectOutput(output, "0000000000000000"), null);
  assert.equal(
    detection.parseClaudeCodeDetectOutput(output.replace(marker("end"), ""), nonce),
    null,
  );
  assert.equal(
    detection.parseClaudeCodeDetectOutput(
      [marker("begin"), marker("bin"), "claude", marker("end")].join("\n"),
      nonce,
    ).binaryPath,
    null,
  );
  const script = detection.buildClaudeCodeDetectScript(nonce);
  assert.match(script, /command -v claude/);
  for (const key of detection.CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS) {
    assert.match(script, new RegExp(`/usr/bin/printenv ${key}`));
  }
  assert.equal(script.includes("printenv;"), false, "no value is printed without its name");
});

// ---------------------------------------------------------------- validation

function validationOptions(overrides = {}) {
  return {
    uid: process.getuid(),
    adminGroupId: null,
    desktopOwnedPaths: [],
    caseInsensitivePaths: process.platform === "darwin",
    ...overrides,
  };
}

test("validation refuses relative, missing, non-executable and writable programs", () => {
  const fixture = makeFixture();
  const check = (file, overrides) =>
    validation.validateClaudeCodeBinary(file, validationOptions(overrides));

  assert.deepEqual(check(fixture.claude), {
    ok: true,
    path: fixture.claude,
    target: fixture.claude,
  });
  assert.equal(check("claude").problem, "relative_path");
  assert.equal(check("bin/claude").problem, "relative_path");
  assert.equal(check(path.join(fixture.binDir, "missing")).problem, "missing");
  assert.equal(check(fixture.binDir).problem, "not_a_file");

  const plain = path.join(fixture.binDir, "plain");
  fs.writeFileSync(plain, "#!/bin/sh\n");
  fs.chmodSync(plain, 0o644);
  assert.equal(check(plain).problem, "not_executable");

  const worldWritable = path.join(fixture.binDir, "world-writable");
  writeExecutable(worldWritable, "#!/bin/sh\n");
  fs.chmodSync(worldWritable, 0o757);
  assert.equal(check(worldWritable).problem, "writable_by_others");

  // Writable by its group: refused, unless that group is the admin group.
  const groupWritable = path.join(fixture.binDir, "group-writable");
  writeExecutable(groupWritable, "#!/bin/sh\n");
  fs.chmodSync(groupWritable, 0o775);
  const gid = fs.statSync(groupWritable).gid;
  assert.equal(check(groupWritable, { adminGroupId: gid + 1 }).problem, "writable_by_others");
  assert.equal(check(groupWritable, { adminGroupId: gid }).ok, true);

  // A folder others can write.
  const openDir = path.join(fixture.root, "open-dir");
  fs.mkdirSync(openDir);
  fs.chmodSync(openDir, 0o777);
  const inOpenDir = path.join(openDir, "claude");
  writeExecutable(inOpenDir, "#!/bin/sh\n");
  assert.equal(check(inOpenDir).problem, "writable_by_others");
});

test("validation refuses programs inside a workspace or project folder, and writable links", () => {
  const fixture = makeFixture();
  const check = (file, overrides) =>
    validation.validateClaudeCodeBinary(file, validationOptions(overrides));

  const projectFolder = path.join(fixture.root, "my-project");
  fs.mkdirSync(path.join(projectFolder, "tools"), { recursive: true });
  const inProject = path.join(projectFolder, "tools", "claude");
  writeExecutable(inProject, "#!/bin/sh\n");
  const inWorkspace = path.join(fixture.workspace, "claude");
  writeExecutable(inWorkspace, "#!/bin/sh\n");
  const owned = { desktopOwnedPaths: [fixture.workspace, projectFolder] };
  assert.equal(check(inWorkspace, owned).problem, "inside_instafy_folder");
  assert.equal(check(inProject, owned).problem, "inside_instafy_folder");
  // A link from outside to a program inside is refused too.
  const linkToProject = path.join(fixture.binDir, "linked-into-project");
  fs.symlinkSync(inProject, linkToProject);
  assert.equal(check(linkToProject, owned).problem, "inside_instafy_folder");

  // A good link keeps its own path; its target is checked.
  const link = path.join(fixture.root, "claude-link");
  fs.symlinkSync(fixture.claude, link);
  assert.deepEqual(check(link), { ok: true, path: link, target: fixture.claude });

  // A link to a target others can write.
  const writableTarget = path.join(fixture.binDir, "writable-target");
  writeExecutable(writableTarget, "#!/bin/sh\n");
  fs.chmodSync(writableTarget, 0o777);
  const linkToWritable = path.join(fixture.root, "link-to-writable");
  fs.symlinkSync(writableTarget, linkToWritable);
  assert.equal(check(linkToWritable).problem, "writable_by_others");

  // A link that sits in a folder others can write.
  const openDir = path.join(fixture.root, "open-links");
  fs.mkdirSync(openDir);
  fs.chmodSync(openDir, 0o777);
  const linkInOpenDir = path.join(openDir, "claude");
  fs.symlinkSync(fixture.claude, linkInOpenDir);
  assert.equal(check(linkInOpenDir).problem, "writable_by_others");
});

// A virtual file system for what a test cannot create: Homebrew's layout,
// owned by the person with the admin group, and a file someone else owns.
function virtualFileSystem(entries) {
  const resolve = (file, depth = 0) => {
    if (depth > 40) {
      throw new Error("loop");
    }
    const parts = file.split("/").filter(Boolean);
    let current = "/";
    for (const part of parts) {
      const next = path.join(current, part);
      const entry = entries[next];
      if (!entry) {
        throw Object.assign(new Error(`ENOENT ${next}`), { code: "ENOENT" });
      }
      current = entry.link ? resolve(path.resolve(current, entry.link), depth + 1) : next;
    }
    return current;
  };
  const stats = (entry) => ({
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    isFile: () => entry.type === "file",
    isDirectory: () => entry.type === "dir",
    isSymbolicLink: () => Boolean(entry.link),
  });
  return {
    lstatSync(file) {
      if (file === "/") {
        return stats({ type: "dir", uid: 0, gid: 0, mode: 0o40755 });
      }
      const entry = entries[file];
      if (!entry) {
        throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      }
      return stats(entry);
    },
    readlinkSync(file) {
      return entries[file].link;
    },
    realpathSync: (file) => resolve(file),
    accessSync(file) {
      if ((entries[resolve(file)].mode & 0o111) === 0) {
        throw new Error("EACCES");
      }
    },
  };
}

test("a target under /opt/homebrew/bin, which only the admin group can also write, passes", () => {
  const person = 501;
  const admin = 80;
  const dir = (uid = person, gid = admin, mode = 0o40775) => ({ type: "dir", uid, gid, mode });
  const files = virtualFileSystem({
    "/opt": dir(0, 0, 0o40755),
    "/opt/homebrew": dir(),
    "/opt/homebrew/bin": dir(),
    "/opt/homebrew/bin/claude": {
      link: "../Caskroom/claude-code/2.1.400/claude",
      uid: person,
      gid: admin,
      mode: 0o120755,
    },
    "/opt/homebrew/Caskroom": dir(),
    "/opt/homebrew/Caskroom/claude-code": dir(),
    "/opt/homebrew/Caskroom/claude-code/2.1.400": dir(),
    "/opt/homebrew/Caskroom/claude-code/2.1.400/claude": {
      type: "file",
      uid: person,
      gid: admin,
      mode: 0o100755,
    },
    "/Users": dir(0, 0, 0o40755),
    "/Users/other": dir(502, 20, 0o40755),
    "/Users/other/claude": { type: "file", uid: 502, gid: 20, mode: 0o100755 },
  });
  const options = {
    uid: person,
    adminGroupId: admin,
    desktopOwnedPaths: [],
    caseInsensitivePaths: true,
    fs: files,
  };
  assert.deepEqual(validation.validateClaudeCodeBinary("/opt/homebrew/bin/claude", options), {
    ok: true,
    path: "/opt/homebrew/bin/claude",
    target: "/opt/homebrew/Caskroom/claude-code/2.1.400/claude",
  });
  assert.equal(
    validation.validateClaudeCodeBinary("/opt/homebrew/bin/claude", {
      ...options,
      adminGroupId: null,
    }).problem,
    "writable_by_others",
  );
  assert.equal(
    validation.validateClaudeCodeBinary("/Users/other/claude", options).problem,
    "foreign_owner",
  );
  // Folder names compare ignoring case, as macOS folders do.
  assert.equal(
    validation.validateClaudeCodeBinary("/opt/homebrew/bin/claude", {
      ...options,
      desktopOwnedPaths: ["/OPT/Homebrew"],
    }).problem,
    "inside_instafy_folder",
  );
});

// runtime-agent's rule for a granted CLAUDE_CONFIG_DIR or CA file
// (claude_code/mod.rs, check_private_location), which refuses the whole grant.
test("a login-shell configuration folder or CA file passes only by runtime-agent's rule", () => {
  const person = 501;
  const admin = 80;
  const dir = (uid = person, gid = 20, mode = 0o40700) => ({ type: "dir", uid, gid, mode });
  const file = (uid = person, gid = 20, mode = 0o100644) => ({ type: "file", uid, gid, mode });
  const link = (target, uid = person) => ({ link: target, uid, gid: 20, mode: 0o120755 });
  const files = virtualFileSystem({
    "/Library": dir(0, 0, 0o40755),
    "/Library/corp-ca.pem": file(0, 0),
    "/Users": dir(0, 0, 0o40755),
    "/Users/person": dir(person, 20, 0o40755),
    "/Users/person/.claude-work": dir(),
    "/Users/person/corp-ca.pem": file(),
    "/Users/person/shared-ca.pem": file(person, 20, 0o100664),
    "/Users/person/open-config": dir(person, 20, 0o40777),
    // The admin group may write the program's folder, never these (D26).
    "/Users/person/admin-config": dir(person, admin, 0o40775),
    "/Users/person/linked-config": link(".claude-work"),
    "/Users/person/foreign-link": link(".claude-work", 502),
    "/Users/person/loop": link("loop"),
    "/Users/person/work": link("/Users/person"),
    "/Users/person/space": dir(),
    "/Users/other": dir(502, 20, 0o40755),
    "/Users/other/ca.pem": file(502),
  });
  const options = { uid: person, desktopOwnedPaths: [], caseInsensitivePaths: true, fs: files };
  const usable = (setting, value, overrides = {}) =>
    validation.claudeCodeShellSettingIsUsable(setting, value, { ...options, ...overrides });

  assert.equal(usable("CLAUDE_CONFIG_DIR", "/Users/person/.claude-work"), true);
  assert.equal(usable("NODE_EXTRA_CA_CERTS", "/Users/person/corp-ca.pem"), true);
  assert.equal(usable("NODE_EXTRA_CA_CERTS", "/Library/corp-ca.pem"), true, "root's own file");
  // A link on the way is followed, the kernel's way, when this user or root owns it.
  assert.equal(usable("CLAUDE_CONFIG_DIR", "/Users/person/linked-config"), true);
  assert.equal(usable("CLAUDE_CONFIG_DIR", "/Users/person/work/.claude-work"), true);
  assert.equal(usable("NODE_EXTRA_CA_CERTS", "/Users/person/work/../person/corp-ca.pem"), true);

  for (const [setting, value] of [
    ["CLAUDE_CONFIG_DIR", "~/.claude-work"],
    ["CLAUDE_CONFIG_DIR", ".claude-work"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/.claude-work\n"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/missing"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/corp-ca.pem"],
    ["NODE_EXTRA_CA_CERTS", "/Users/person/.claude-work"],
    ["NODE_EXTRA_CA_CERTS", "/Users/person/shared-ca.pem"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/open-config"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/admin-config"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/foreign-link"],
    ["CLAUDE_CONFIG_DIR", "/Users/person/loop"],
    ["NODE_EXTRA_CA_CERTS", "/Users/other/ca.pem"],
  ]) {
    assert.equal(usable(setting, value), false, `${setting}=${JSON.stringify(value)}`);
  }

  // Not in a folder Instafy owns, as given or after links; names compare ignoring case.
  assert.equal(
    usable("CLAUDE_CONFIG_DIR", "/Users/person/.claude-work", { desktopOwnedPaths: ["/USERS/Person"] }),
    false,
  );
  assert.equal(
    usable("CLAUDE_CONFIG_DIR", "/Users/person/linked-config", {
      desktopOwnedPaths: ["/Users/person/.claude-work"],
    }),
    false,
  );
  // As given, a value that passes through an owned folder is inside it.
  assert.equal(usable("NODE_EXTRA_CA_CERTS", "/Users/person/space/../corp-ca.pem"), true);
  assert.equal(
    usable("NODE_EXTRA_CA_CERTS", "/Users/person/space/../corp-ca.pem", {
      desktopOwnedPaths: ["/Users/person/space"],
    }),
    false,
  );

  // Only the two values that name a place are checked, in runtime-agent's order.
  const find = (env) => validation.findUnusableClaudeCodeShellSetting(env, options);
  assert.equal(find({ HTTPS_PROXY: "relative", NO_PROXY: "*" }), null);
  assert.equal(
    find({ CLAUDE_CONFIG_DIR: "/Users/person/.claude-work", NODE_EXTRA_CA_CERTS: "/Library/corp-ca.pem" }),
    null,
  );
  assert.equal(
    find({ NODE_EXTRA_CA_CERTS: "/Users/other/ca.pem", CLAUDE_CONFIG_DIR: "~/.claude-work" }),
    "CLAUDE_CONFIG_DIR",
  );
  assert.equal(find({ NODE_EXTRA_CA_CERTS: "/Users/other/ca.pem" }), "NODE_EXTRA_CA_CERTS");
});

test("the configuration folder and CA file checks hold on a real file system", () => {
  const fixture = makeFixture();
  const options = {
    uid: process.getuid(),
    desktopOwnedPaths: [fixture.workspace],
    caseInsensitivePaths: process.platform === "darwin",
  };
  const usable = (setting, value) =>
    validation.claudeCodeShellSettingIsUsable(setting, value, options);
  assert.equal(usable("CLAUDE_CONFIG_DIR", fixture.configDir), true);
  assert.equal(usable("NODE_EXTRA_CA_CERTS", fixture.caFile), true);
  assert.equal(usable("CLAUDE_CONFIG_DIR", fixture.sharedConfigDir), false);
  const homeLink = path.join(fixture.root, "home-link");
  fs.symlinkSync(fixture.home, homeLink);
  assert.equal(usable("CLAUDE_CONFIG_DIR", path.join(homeLink, ".claude-work")), true);
  fs.chmodSync(fixture.caFile, 0o664);
  assert.equal(usable("NODE_EXTRA_CA_CERTS", fixture.caFile), false);
  fs.chmodSync(fixture.caFile, 0o644);
  const inWorkspace = path.join(fixture.workspace, ".claude");
  fs.mkdirSync(inWorkspace, { mode: 0o700 });
  assert.equal(usable("CLAUDE_CONFIG_DIR", inWorkspace), false);
});

// ------------------------------------------------------------- the module

test("off macOS, status reports supported: false and no grant resolves", async () => {
  const context = setup({ platform: "linux" });
  const consents = context.consents;
  // Even a record left behind grants nothing there.
  const store = registry.createDesktopExtensionConsentStore(consents, {
    moduleId: claudeCode.CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID,
    controllerOrigin: CONTROLLER,
    userId: USER_A,
  });
  store.write({
    binaryPath: context.fixture.claude,
    pathEntries: [],
    env: {},
    consentedAt: NOW.toISOString(),
    osUser: "fixture-user",
  });
  const dialogs = fakeDialogs();
  const host = hostFor({ consents, dialogs });
  for (const method of ["status", "detect", "locate", "enable"]) {
    assert.deepEqual(await context.invoke(method, host), {
      supported: false,
      found: false,
      consented: false,
    });
  }
  assert.equal(dialogs.shown.length + dialogs.picks, 0);
  assert.equal(await context.grantFor(USER_A), null);
});

test("consent is per controller and per user, and grants only the consenting user", async () => {
  const context = setup();
  const dialogs = fakeDialogs();
  const hostA = hostFor({ consents: context.consents, dialogs });

  assert.deepEqual(await context.invoke("status", hostA), {
    supported: true,
    found: false,
    consented: false,
  });
  assert.deepEqual(await context.invoke("detect", hostA), {
    supported: true,
    found: true,
    path: context.fixture.claude,
    consented: false,
  });
  // A found path is not a consent.
  assert.equal(await context.grantFor(USER_A), null);
  assert.deepEqual(await context.invoke("enable", hostA), {
    supported: true,
    found: true,
    path: context.fixture.claude,
    consented: true,
  });

  const grant = await context.grantFor(USER_A);
  assert.equal(grant.localEngine, "claude-code");
  assert.deepEqual(Object.keys(grant.env).sort(), [...GRANT_KEYS].sort());
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_BIN, context.fixture.claude);
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_PATH, `${context.fixture.binDir}:/usr/bin:/bin`);
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_USER_ID, USER_A);
  assert.deepEqual(JSON.parse(grant.env.INSTAFY_CLAUDE_CODE_ENV_JSON), {
    CLAUDE_CONFIG_DIR: path.join(context.fixture.home, ".claude-work"),
    HTTPS_PROXY: PROXY_WITH_PASSWORD,
    HTTP_PROXY: "http://proxy.corp.example:3128",
    NO_PROXY: "localhost,.corp.example",
    NODE_EXTRA_CA_CERTS: path.join(context.fixture.home, "corp-ca.pem"),
  });

  // Another controller, or another Instafy user, has no consent.
  assert.equal(await context.grantFor(USER_A, OTHER_CONTROLLER), null);
  assert.equal(await context.grantFor(USER_B), null);
  assert.equal(
    (await context.invoke("status", hostFor({ consents: context.consents, controllerOrigin: OTHER_CONTROLLER }))).consented,
    false,
  );
  assert.equal(
    (await context.invoke("status", hostFor({ consents: context.consents, userId: USER_B }))).consented,
    false,
  );
  // A start bound to nobody (fixed credentials) is granted nothing.
  assert.equal(await context.grantFor(null), null);

  // Turning it off removes the record, and with it the grant.
  assert.equal((await context.invoke("disable", hostA)).consented, false);
  assert.equal(await context.grantFor(USER_A), null);
  assert.deepEqual(context.consents.read(), {});
});

test("a start bound to the visible session gets its user's grant, in an unpackaged build too", async () => {
  const context = setup();
  await consentAs(context, hostFor({ consents: context.consents }));
  const tokenA = "token-for-a";
  const visibleA = { accessToken: tokenA, userId: USER_A };

  for (const allowAmbientRefresh of [true, false]) {
    const provenance = trust.resolveDesktopControllerStartCredentialProvenance({
      credentialMode: "ambient",
      controllerAccessToken: tokenA,
      visibleSession: visibleA,
      allowAmbientRefresh,
    });
    // Unpackaged builds keep the credential fixed, but the start is still bound.
    assert.equal(provenance.kind, allowAmbientRefresh ? "ambient" : "fixed");
    const boundUser = trust.resolveDesktopControllerStartBoundUserId({
      credentialMode: "ambient",
      controllerAccessToken: tokenA,
      visibleSession: visibleA,
    });
    assert.equal(boundUser, USER_A);
    assert.notEqual(await context.grantFor(boundUser), null);
  }

  // A start that asked for fixed credentials is bound to nobody: no grant.
  const fixedUser = trust.resolveDesktopControllerStartBoundUserId({
    credentialMode: "fixed",
    controllerAccessToken: tokenA,
    visibleSession: visibleA,
  });
  assert.equal(fixedUser, null);
  assert.equal(await context.grantFor(fixedUser), null);

  // A user switch drops the grant, so the start check sees a different grant.
  const grantsA = await context.extensions.resolveLaunchGrants({
    projectId: PROJECT_ID,
    controllerOrigin: CONTROLLER,
    instafyUserId: USER_A,
    consents: context.consents,
  });
  const grantsB = await context.extensions.resolveLaunchGrants({
    projectId: PROJECT_ID,
    controllerOrigin: CONTROLLER,
    instafyUserId: trust.resolveDesktopControllerStartBoundUserId({
      credentialMode: "ambient",
      controllerAccessToken: "token-for-b",
      visibleSession: { accessToken: "token-for-b", userId: USER_B },
    }),
    consents: context.consents,
  });
  assert.equal(grantsB[0].grant, null);
  assert.equal(registry.desktopRuntimeLaunchGrantsEqual(grantsA, grantsB), false);
  assert.deepEqual(registry.desktopRuntimeLaunchGrantsForStart(grantsB), [
    { protectedEnvKeys: GRANT_KEYS },
  ]);
});

test("the consent dialog names the host context's account, never a user id in the payload", async () => {
  const context = setup();
  const dialogs = fakeDialogs();
  const hostA = hostFor({ consents: context.consents, dialogs });
  await context.invoke("detect", hostA, { userId: USER_B, instafyUserId: USER_B });
  await context.invoke("enable", hostA, {
    userId: USER_B,
    instafyUserId: USER_B,
    email: "person-b@example.test",
    binaryPath: "/tmp/not-this-one",
  });

  assert.equal(dialogs.shown.length, 1);
  const [dialog] = dialogs.shown;
  assert.equal(dialog.message, "Use Claude Code on this computer for person-a@example.test?");
  assert.deepEqual(dialog.buttons, ["Use Claude Code", "Cancel"]);
  assert.equal(dialog.cancelId, 1);
  assert.equal(dialog.defaultId, 1);
  assert.ok(dialog.detail.startsWith(consent.CLAUDE_CODE_CONSENT_TEXT));
  assert.ok(dialog.detail.includes(`Program: ${context.fixture.claude}`));
  assert.ok(dialog.detail.includes(`HTTPS_PROXY=${PROXY_WITH_PASSWORD}`));
  assert.equal(dialog.detail.includes(consent.CLAUDE_CODE_OTHER_ACCOUNT_TEXT), false);

  assert.notEqual(await context.grantFor(USER_A), null);
  assert.equal(await context.grantFor(USER_B), null);
});

test("the consent text is the design's, and the dialog adds 4.5's note for a second account", async () => {
  assert.equal(
    consent.CLAUDE_CODE_CONSENT_TEXT,
    "When you choose Claude Code for a message in Instafy, Instafy Desktop starts the claude program on this computer, signed in the way you signed in to it yourself, to carry out that one message. It runs under Anthropic's current terms, and that sign-in may bill your Claude plan or your own API or cloud account. Only your own Instafy account can start these turns, one at a time. Instafy gives Claude Code your message exactly as you wrote it and adds nothing. Everyone in the space can read the steps it takes and its reply. Claude Code uses your own Claude Code settings, including what you've allowed it to run without asking, except that it changes files in this space's folder without asking, whatever your own setting says, and skips anything else that would need your OK. What others wrote in this space's files can steer it within those settings: it may copy files kept only on this computer, such as .env, into its reply or into files saved to the space, and run the space's code through commands or hooks you've allowed. Instafy never reads, stores or sends your Claude sign-in. Only turn this on if the Claude account signed in on this computer account is yours.",
  );
  assert.equal(
    consent.CLAUDE_CODE_OTHER_ACCOUNT_TEXT,
    "Another Instafy account on this computer account also uses Claude Code. Claude Code turns run on whichever Claude sign-in this computer account has. Only continue if it is yours.",
  );
  for (const banned of ["included", "free", "unlimited"]) {
    assert.equal(consent.CLAUDE_CODE_CONSENT_TEXT.toLowerCase().includes(banned), false, banned);
  }

  const context = setup();
  await consentAs(context, hostFor({ consents: context.consents, userId: USER_B, email: "b@example.test" }));
  const dialogs = fakeDialogs();
  await consentAs(context, hostFor({ consents: context.consents, dialogs }));
  assert.ok(dialogs.shown[0].detail.includes(consent.CLAUDE_CODE_OTHER_ACCOUNT_TEXT));
});

test("cancelling the dialog stores nothing; no session, or no email, stores nothing either", async () => {
  const context = setup();
  const dialogs = fakeDialogs({ answer: 1 });
  const hostA = hostFor({ consents: context.consents, dialogs });
  assert.equal((await consentAs(context, hostA)).consented, false);
  assert.deepEqual(context.consents.read(), {});

  const signedOut = hostFor({ consents: context.consents, userId: null });
  assert.deepEqual(await context.invoke("status", signedOut), {
    supported: true,
    found: false,
    consented: false,
  });
  await assert.rejects(context.invoke("enable", signedOut), /Sign in/);
  const noController = hostFor({ consents: context.consents, controllerOrigin: null });
  await assert.rejects(context.invoke("detect", noController), /Start a space/);
  await assert.rejects(
    context.invoke("enable", hostFor({ consents: context.consents, email: null })),
    /email/,
  );
  assert.deepEqual(context.consents.read(), {});
});

test("extension methods return no secrets", async () => {
  const context = setup();
  const dialogs = fakeDialogs({ pick: context.fixture.otherClaude });
  const host = hostFor({ consents: context.consents, dialogs });
  const results = [];
  for (const method of ["status", "detect", "enable", "status", "locate", "disable"]) {
    results.push(await context.invoke(method, host));
  }
  const returned = JSON.stringify(results);
  for (const secret of [
    "proxy-password",
    PROXY_WITH_PASSWORD,
    ".claude-work",
    "corp-ca.pem",
    "corp.example",
    "never-printed",
    "INSTAFY_CLAUDE_CODE",
  ]) {
    assert.equal(returned.includes(secret), false, `a method returned ${secret}`);
  }
  for (const result of results) {
    assert.deepEqual(
      Object.keys(result).filter((key) => !STATUS_KEYS.includes(key)),
      [],
    );
  }
});

test("locate stores a picked program only when it validates, and updates a lane that is on", async () => {
  const context = setup();
  const dialogs = fakeDialogs({ pick: null });
  const host = hostFor({ consents: context.consents, dialogs });

  // Cancelled.
  assert.equal((await context.invoke("locate", host)).found, false);
  // Refused: it does not change anything.
  const plain = path.join(context.fixture.root, "not-executable");
  fs.writeFileSync(plain, "x");
  fs.chmodSync(plain, 0o644);
  dialogs.pick = plain;
  assert.deepEqual(await context.invoke("locate", host), {
    supported: true,
    found: false,
    path: plain,
    consented: false,
    problem: "not_executable",
  });
  assert.equal((await context.invoke("status", host)).found, false);

  // Not consented: a found program, still not a consent.
  dialogs.pick = context.fixture.otherClaude;
  assert.equal((await context.invoke("locate", host)).path, context.fixture.otherClaude);
  assert.equal(await context.grantFor(USER_A), null);
  await context.invoke("enable", host);
  assert.equal(
    (await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_BIN,
    context.fixture.otherClaude,
  );

  // Consented: a new path changes the grant at once.
  dialogs.pick = context.fixture.claude;
  assert.equal((await context.invoke("locate", host)).path, context.fixture.claude);
  assert.equal(
    (await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_BIN,
    context.fixture.claude,
  );
});

test("a record from another OS account or a malformed one grants nothing", async () => {
  const context = setup();
  const store = registry.createDesktopExtensionConsentStore(context.consents, {
    moduleId: claudeCode.CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID,
    controllerOrigin: CONTROLLER,
    userId: USER_A,
  });
  const record = {
    binaryPath: context.fixture.claude,
    pathEntries: ["/usr/bin"],
    env: {},
    consentedAt: NOW.toISOString(),
    osUser: "someone-else",
  };
  store.write(record);
  assert.equal(await context.grantFor(USER_A), null);
  store.write({ ...record, osUser: "fixture-user", env: { ANTHROPIC_BASE_URL: "https://x" } });
  assert.equal(await context.grantFor(USER_A), null);
  store.write({ ...record, osUser: "fixture-user", pathEntries: ["relative"] });
  assert.equal(await context.grantFor(USER_A), null);
  store.write({ ...record, osUser: "fixture-user" });
  assert.notEqual(await context.grantFor(USER_A), null);
});

const FIVE_SHELL_VALUES = (fixture) => ({
  CLAUDE_CONFIG_DIR: fixture.configDir,
  HTTPS_PROXY: PROXY_WITH_PASSWORD,
  HTTP_PROXY: "http://proxy.corp.example:3128",
  NO_PROXY: "localhost,.corp.example",
  NODE_EXTRA_CA_CERTS: fixture.caFile,
});

test("a login-shell configuration folder or CA file Desktop can't use is named, and never consented to", async () => {
  for (const [shell, setting] of [
    ["relativeConfig", "CLAUDE_CONFIG_DIR"],
    ["sharedConfig", "CLAUDE_CONFIG_DIR"],
    ["missingCa", "NODE_EXTRA_CA_CERTS"],
  ]) {
    const context = setup();
    context.useShell(shell);
    const dialogs = fakeDialogs();
    const host = hostFor({ consents: context.consents, dialogs });
    const refused = {
      supported: true,
      found: false,
      path: context.fixture.claude,
      consented: false,
      problem: "shell_setting_unusable",
      shellSetting: setting,
    };
    assert.deepEqual(await context.invoke("detect", host), refused, shell);
    assert.deepEqual(await context.invoke("status", host), refused, shell);
    // runtime-agent would refuse every turn with it, so nobody is asked.
    assert.deepEqual(await context.invoke("enable", host), refused, shell);
    assert.equal(dialogs.shown.length, 0, shell);
    assert.deepEqual(context.consents.read(), {}, shell);
    assert.equal(await context.grantFor(USER_A), null, shell);
  }

  // Locate takes the login shell's values too, and is held to the same rule.
  const context = setup();
  context.useShell("sharedConfig");
  const dialogs = fakeDialogs({ pick: context.fixture.otherClaude });
  assert.deepEqual(await context.invoke("locate", hostFor({ consents: context.consents, dialogs })), {
    supported: true,
    found: false,
    path: context.fixture.otherClaude,
    consented: false,
    problem: "shell_setting_unusable",
    shellSetting: "CLAUDE_CONFIG_DIR",
  });
});

test("a configuration folder or CA file that changes after consent shows as the problem", async () => {
  const context = setup();
  const host = hostFor({ consents: context.consents });
  const { claude, caFile, configDir } = context.fixture;
  const on = { supported: true, found: true, path: claude, consented: true };
  assert.deepEqual(await consentAs(context, host), on);
  const grant = await context.grantFor(USER_A);

  fs.rmSync(caFile);
  assert.deepEqual(await context.invoke("status", host), {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "NODE_EXTRA_CA_CERTS",
  });
  // The grant stays what the person consented to; runtime-agent checks it again before each turn.
  assert.deepEqual(await context.grantFor(USER_A), grant);
  fs.writeFileSync(caFile, "fixture CA bundle\n");
  fs.chmodSync(caFile, 0o644);
  assert.deepEqual(await context.invoke("status", host), on);

  fs.chmodSync(configDir, 0o770);
  assert.deepEqual(await context.invoke("status", host), {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "CLAUDE_CONFIG_DIR",
  });
  fs.chmodSync(configDir, 0o700);
  assert.deepEqual(await context.invoke("status", host), on);
});

test("while the lane is on, Find and a refused Locate answer the path in use, with what they found beside it", async () => {
  const context = setup();
  const dialogs = fakeDialogs();
  const host = hostFor({ consents: context.consents, dialogs });
  const { claude, otherClaude } = context.fixture;
  const on = { supported: true, found: true, path: claude, consented: true };
  assert.deepEqual(await consentAs(context, host), on);
  const binaryInUse = async () => (await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_BIN;

  // Find turns up another program: turns keep the one in use, so the answer does too.
  context.useShell("foundOther");
  assert.deepEqual(await context.invoke("detect", host), { ...on, candidatePath: otherClaude });
  assert.deepEqual(await context.invoke("status", host), { ...on, candidatePath: otherClaude });
  assert.equal(await binaryInUse(), claude);

  // Find turns up nothing: the program in use still works.
  context.useShell("alias");
  assert.deepEqual(await context.invoke("detect", host), { ...on, candidateProblem: "not_found" });
  assert.deepEqual(await context.invoke("status", host), { ...on, candidateProblem: "not_found" });

  // A pick Desktop can't use changes nothing, and shows only in its own answer.
  const plain = path.join(context.fixture.root, "not-executable");
  fs.writeFileSync(plain, "x");
  fs.chmodSync(plain, 0o644);
  dialogs.pick = plain;
  assert.deepEqual(await context.invoke("locate", host), {
    ...on,
    candidatePath: plain,
    candidateProblem: "not_executable",
  });
  assert.deepEqual(await context.invoke("status", host), { ...on, candidateProblem: "not_found" });
  assert.equal(await binaryInUse(), claude);

  // Another program whose login-shell values Desktop can't use: named, and not consented to.
  context.useShell("otherSharedConfig");
  const unusable = {
    ...on,
    candidatePath: otherClaude,
    candidateProblem: "shell_setting_unusable",
    shellSetting: "CLAUDE_CONFIG_DIR",
  };
  assert.deepEqual(await context.invoke("detect", host), unusable);
  const asked = dialogs.shown.length;
  assert.deepEqual(await context.invoke("enable", host), unusable);
  assert.equal(dialogs.shown.length, asked);
  assert.equal(await binaryInUse(), claude);

  // Use for my messages confirms what Find turned up, through the consent dialog.
  context.useShell("foundOther");
  assert.deepEqual(await context.invoke("detect", host), { ...on, candidatePath: otherClaude });
  assert.deepEqual(await context.invoke("enable", host), { ...on, path: otherClaude });
  assert.ok(dialogs.shown[dialogs.shown.length - 1].detail.includes(`Program: ${otherClaude}`));
  assert.equal(await binaryInUse(), otherClaude);
});

test("while the lane is on, Find offers the program in use again with login-shell values that replace recorded ones Desktop can't use", async () => {
  const context = setup();
  const dialogs = fakeDialogs();
  const host = hostFor({ consents: context.consents, dialogs });
  const { claude, otherClaude, caFile, configDir } = context.fixture;
  const on = { supported: true, found: true, path: claude, consented: true };
  assert.deepEqual(await consentAs(context, host), on);
  const grantedEnv = async () =>
    JSON.parse((await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_ENV_JSON);

  // The CA file goes after consent. A Find whose shell still names it reads nothing new.
  fs.rmSync(caFile);
  const stale = {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "NODE_EXTRA_CA_CERTS",
  };
  assert.deepEqual(await context.invoke("detect", host), stale);
  // New values Desktop can't use either are not offered, and nobody is asked about them.
  context.useShell("sharedConfig");
  assert.deepEqual(await context.invoke("detect", host), stale);
  const asked = dialogs.shown.length;
  assert.deepEqual(await context.invoke("enable", host), stale);
  assert.equal(dialogs.shown.length, asked);

  // The person stops exporting it and chooses Find: the program in use shows
  // beside itself, and turns keep the recorded values until Use for my
  // messages confirms the new ones.
  context.useShell("configOnly");
  const renewed = { ...stale, candidatePath: claude };
  assert.deepEqual(await context.invoke("detect", host), renewed);
  assert.deepEqual(await context.invoke("status", host), renewed);
  assert.equal((await grantedEnv()).NODE_EXTRA_CA_CERTS, caFile);

  // Locating the program in use keeps that find, and drops a find of another program.
  dialogs.pick = claude;
  assert.deepEqual(await context.invoke("locate", host), renewed);
  context.useShell("foundOther");
  assert.deepEqual(await context.invoke("detect", host), {
    ...stale,
    candidatePath: otherClaude,
    candidateProblem: "shell_setting_unusable",
  });
  assert.deepEqual(await context.invoke("locate", host), stale);
  assert.equal((await grantedEnv()).NODE_EXTRA_CA_CERTS, caFile);

  // Use for my messages confirms the new values through the consent dialog.
  context.useShell("configOnly");
  assert.deepEqual(await context.invoke("detect", host), renewed);
  assert.deepEqual(await context.invoke("enable", host), on);
  assert.equal(dialogs.shown.length, asked + 1);
  const { detail } = dialogs.shown[asked];
  assert.ok(detail.includes(`Program: ${claude}`));
  assert.ok(detail.includes(`CLAUDE_CONFIG_DIR=${configDir}`));
  assert.equal(detail.includes("NODE_EXTRA_CA_CERTS"), false);
  assert.deepEqual(await grantedEnv(), { CLAUDE_CONFIG_DIR: configDir });
  assert.deepEqual(await context.invoke("status", host), on);

  // Once the recorded values pass, a Find of the same program with other
  // values offers nothing, and Use for my messages confirms the record as it is.
  fs.writeFileSync(caFile, "fixture CA bundle\n");
  fs.chmodSync(caFile, 0o644);
  context.useShell("found");
  assert.deepEqual(await context.invoke("detect", host), on);
  assert.deepEqual(await context.invoke("status", host), on);
  assert.deepEqual(await context.invoke("enable", host), on);
  assert.equal(dialogs.shown.length, asked + 2);
  assert.equal(
    dialogs.shown[asked + 1].detail,
    consentDetail(`Program: ${claude}`, `From your login shell:\nCLAUDE_CONFIG_DIR=${configDir}`),
  );
  assert.deepEqual(await grantedEnv(), { CLAUDE_CONFIG_DIR: configDir });
});

test("while the lane is on, a Find whose login shell gave no answer offers no new values, and Use for my messages keeps the recorded ones", async () => {
  // Short, so the shell that hangs runs out quickly. No shell here has to
  // answer: the record is written as Use for my messages writes it.
  const context = setup({ detectTimeoutMs: 1_000 });
  const { fixture } = context;
  // Where the native installer puts claude, the first place Find looks when
  // the login shell gives no answer.
  const localBin = path.join(fixture.home, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.chmodSync(path.join(fixture.home, ".local"), 0o755);
  fs.chmodSync(localBin, 0o755);
  const localClaude = path.join(localBin, "claude");
  writeExecutable(localClaude, "#!/bin/sh\nexit 0\n");
  writeConsentRecord(context, {
    binaryPath: localClaude,
    pathEntries: [localBin, "/usr/bin", "/bin"],
    env: { CLAUDE_CONFIG_DIR: fixture.configDir, NODE_EXTRA_CA_CERTS: fixture.caFile },
  });
  const dialogs = fakeDialogs();
  const host = hostFor({ consents: context.consents, dialogs });
  const on = { supported: true, found: true, path: localClaude, consented: true };
  const grant = await context.grantFor(USER_A);

  // Such a Find turns up the program in use with no PATH and no values. It
  // shows nothing beside it, and confirming again asks about the recorded
  // values, never the empty ones.
  context.useShell("noMarkers");
  assert.deepEqual(await context.invoke("detect", host), on);
  assert.deepEqual(await context.invoke("enable", host), on);
  assert.equal(dialogs.shown.length, 1);
  assert.ok(dialogs.shown[0].detail.includes(`NODE_EXTRA_CA_CERTS=${fixture.caFile}`));
  assert.deepEqual(await context.grantFor(USER_A), grant);

  // The CA file goes. That Find read nothing, so it offers nothing in its place.
  fs.rmSync(fixture.caFile);
  const stale = {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "NODE_EXTRA_CA_CERTS",
  };
  assert.deepEqual(await context.invoke("status", host), stale);
  // Nor does a Find whose shell prints no markers, runs past its time limit,
  // prints past the output cap or is not in /etc/shells, and Use for my
  // messages asks about none of them.
  for (const shell of ["noMarkers", "slow", "chatty", "unlisted"]) {
    context.useShell(shell);
    assert.deepEqual(await context.invoke("detect", host), stale, shell);
    assert.deepEqual(await context.invoke("enable", host), stale, shell);
  }
  assert.equal(dialogs.shown.length, 1);
  assert.deepEqual(await context.grantFor(USER_A), grant);
});

test("while the lane is on, a Find whose login shell names no program, as for an alias, offers its new values for the program in use", async () => {
  const context = setup();
  const { claude, configDir, caFile } = context.fixture;
  const dialogs = fakeDialogs({ pick: claude });
  const host = hostFor({ consents: context.consents, dialogs });
  const on = { supported: true, found: true, path: claude, consented: true };
  const grantedEnv = async () =>
    JSON.parse((await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_ENV_JSON);

  // Find can't follow an alias, so the person located the program. Locate
  // read the login shell, and Use for my messages recorded its values.
  context.useShell("aliasValues");
  assert.deepEqual(await context.invoke("locate", host), { ...on, consented: false });
  assert.deepEqual(await context.invoke("enable", host), on);
  assert.equal((await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_PATH, "/usr/bin:/bin");
  assert.deepEqual(await grantedEnv(), { CLAUDE_CONFIG_DIR: configDir, NODE_EXTRA_CA_CERTS: caFile });

  // The CA file goes. A Find whose shell still names it, names a folder
  // Desktop can't use either, or gives no answer, found no other program and
  // offers nothing, and Use for my messages asks about none of them.
  fs.rmSync(caFile);
  const stale = {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "NODE_EXTRA_CA_CERTS",
  };
  for (const shell of ["aliasValues", "aliasSharedConfig", "noMarkers"]) {
    context.useShell(shell);
    const nothingNew = { ...stale, candidateProblem: "not_found" };
    assert.deepEqual(await context.invoke("detect", host), nothingNew, shell);
    assert.deepEqual(await context.invoke("enable", host), nothingNew, shell);
  }
  assert.equal(dialogs.shown.length, 1);
  // Locating the program in use drops the last of those finds, which read nothing.
  assert.deepEqual(await context.invoke("locate", host), stale);

  // The person stops exporting it and chooses Find. Still no program, but
  // values that pass with the one in use, which shows beside itself.
  context.useShell("aliasConfigOnly");
  const renewed = { ...stale, candidatePath: claude };
  assert.deepEqual(await context.invoke("detect", host), renewed);
  assert.deepEqual(await context.invoke("status", host), renewed);
  // Locating the program in use keeps that find, and turns keep the recorded values.
  assert.deepEqual(await context.invoke("locate", host), renewed);
  assert.equal((await grantedEnv()).NODE_EXTRA_CA_CERTS, caFile);

  // Use for my messages confirms the program in use with that Find's PATH
  // and values, through the consent dialog, which lists the program and the
  // values as for any consent; the PATH entries go only into the record. The
  // find stays, and with the recorded values passing it shows only that it
  // found no other program.
  const confirmed = { ...on, candidateProblem: "not_found" };
  const listed = consentDetail(
    `Program: ${claude}`,
    `From your login shell:\nCLAUDE_CONFIG_DIR=${configDir}`,
  );
  assert.deepEqual(await context.invoke("enable", host), confirmed);
  assert.equal(dialogs.shown.length, 2);
  assert.equal(dialogs.shown[1].detail, listed);
  const grant = await context.grantFor(USER_A);
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_BIN, claude);
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_PATH, "/opt/corp-tools/bin:/usr/bin:/bin");
  assert.deepEqual(await grantedEnv(), { CLAUDE_CONFIG_DIR: configDir });
  assert.deepEqual(await context.invoke("status", host), confirmed);

  // While the recorded values pass, a Find of no program with other values
  // that pass offers nothing, and Use for my messages confirms the record as it is.
  fs.writeFileSync(caFile, "fixture CA bundle\n");
  fs.chmodSync(caFile, 0o644);
  context.useShell("aliasValues");
  assert.deepEqual(await context.invoke("detect", host), confirmed);
  assert.deepEqual(await context.invoke("enable", host), confirmed);
  assert.equal(dialogs.shown.length, 3);
  assert.equal(dialogs.shown[2].detail, listed);
  assert.deepEqual(await context.grantFor(USER_A), grant);
});

test("while the lane is on, a Find whose login shell names no program shows a copy it turns up in a usual folder, not new values for the program in use", async () => {
  const context = setup();
  const { fixture } = context;
  const { claude, configDir, caFile } = fixture;
  const dialogs = fakeDialogs({ pick: claude });
  const host = hostFor({ consents: context.consents, dialogs });
  const on = { supported: true, found: true, path: claude, consented: true };
  // Find can't follow the login shell's alias, so the person located the
  // program, and Use for my messages recorded the values Locate read. Then
  // the CA file goes.
  context.useShell("aliasValues");
  await context.invoke("locate", host);
  assert.deepEqual(await context.invoke("enable", host), on);
  const grant = await context.grantFor(USER_A);
  fs.rmSync(caFile);
  const stale = {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "NODE_EXTRA_CA_CERTS",
  };

  // The shell's alias names no program, so Find looks in the usual folders,
  // where an earlier install left a link whose target is gone. Find shows
  // that copy with its problem, though the shell's new values pass with the
  // program in use, and Use for my messages asks nothing.
  const localBin = path.join(fixture.home, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.chmodSync(path.join(fixture.home, ".local"), 0o755);
  fs.chmodSync(localBin, 0o755);
  const localClaude = path.join(localBin, "claude");
  fs.symlinkSync(path.join(fixture.home, ".local", "share", "claude", "versions", "1.0.0"), localClaude);
  context.useShell("aliasConfigOnly");
  const gone = { ...stale, candidatePath: localClaude, candidateProblem: "missing" };
  assert.deepEqual(await context.invoke("detect", host), gone);
  assert.deepEqual(await context.invoke("enable", host), gone);
  assert.equal(dialogs.shown.length, 1);
  assert.deepEqual(await context.grantFor(USER_A), grant);

  // A copy there that Desktop can use shows as another program with the new
  // values, and Use for my messages switches to it.
  fs.rmSync(localClaude);
  writeExecutable(localClaude, "#!/bin/sh\nexit 0\n");
  assert.deepEqual(await context.invoke("detect", host), { ...stale, candidatePath: localClaude });
  assert.deepEqual(await context.invoke("enable", host), { ...on, path: localClaude });
  assert.equal(dialogs.shown.length, 2);
  assert.equal(
    dialogs.shown[1].detail,
    consentDetail(`Program: ${localClaude}`, `From your login shell:\nCLAUDE_CONFIG_DIR=${configDir}`),
  );
  const switched = await context.grantFor(USER_A);
  assert.equal(switched.env.INSTAFY_CLAUDE_CODE_BIN, localClaude);
  assert.equal(switched.env.INSTAFY_CLAUDE_CODE_PATH, "/opt/corp-tools/bin:/usr/bin:/bin");
  assert.deepEqual(JSON.parse(switched.env.INSTAFY_CLAUDE_CODE_ENV_JSON), { CLAUDE_CONFIG_DIR: configDir });
});

test("Locate without a Find reads the login shell, so the grant carries its PATH and D26 values", async () => {
  const context = setup();
  const { fixture } = context;
  const dialogs = fakeDialogs({ pick: fixture.otherClaude });
  const host = hostFor({ consents: context.consents, dialogs });

  assert.equal(fs.existsSync(fixture.envDump), false);
  assert.deepEqual(await context.invoke("locate", host), {
    supported: true,
    found: true,
    path: fixture.otherClaude,
    consented: false,
  });
  assert.equal(fs.existsSync(fixture.envDump), true, "the login shell ran, as for Find");
  assert.equal((await context.invoke("enable", host)).consented, true);
  const [dialog] = dialogs.shown;
  assert.ok(dialog.detail.includes(`Program: ${fixture.otherClaude}`));
  for (const [key, value] of Object.entries(FIVE_SHELL_VALUES(fixture))) {
    assert.ok(dialog.detail.includes(`${key}=${value}`), `the dialog lists ${key}`);
  }
  const grant = await context.grantFor(USER_A);
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_BIN, fixture.otherClaude);
  // The picked program, with the shell's PATH.
  assert.equal(grant.env.INSTAFY_CLAUDE_CODE_PATH, `${fixture.binDir}:/usr/bin:/bin`);
  assert.deepEqual(JSON.parse(grant.env.INSTAFY_CLAUDE_CODE_ENV_JSON), FIVE_SHELL_VALUES(fixture));

  // What the shell said stays for the next Locate, which does not run it again.
  fs.rmSync(fixture.envDump);
  await context.invoke("disable", host);
  dialogs.pick = fixture.claude;
  assert.equal((await context.invoke("locate", host)).path, fixture.claude);
  assert.equal(fs.existsSync(fixture.envDump), false);
  await context.invoke("enable", host);
  assert.deepEqual(
    JSON.parse((await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_ENV_JSON),
    FIVE_SHELL_VALUES(fixture),
  );

  // A login shell that gives no answer leaves them empty, as it does for Find.
  const quiet = setup();
  quiet.useShell("noMarkers");
  const quietHost = hostFor({
    consents: quiet.consents,
    dialogs: fakeDialogs({ pick: quiet.fixture.claude }),
  });
  assert.equal((await quiet.invoke("locate", quietHost)).found, true);
  await quiet.invoke("enable", quietHost);
  const quietGrant = await quiet.grantFor(USER_A);
  assert.equal(quietGrant.env.INSTAFY_CLAUDE_CODE_PATH, "");
  assert.equal(quietGrant.env.INSTAFY_CLAUDE_CODE_ENV_JSON, "{}");
});

// ------------------------------------------------------ restarts (4.3, 4.4)

function runtimeHarness(context) {
  const replaced = [];
  const state = {
    runtime: {
      handle: "runtime-1",
      projectId: PROJECT_ID,
      controllerOrigin: CONTROLLER,
      instafyUserId: USER_A,
      launchGrants: context.extensions.launchGrantsWithoutValues(),
    },
    decision: "replaced",
  };
  const invoke = (methodId, host) =>
    registry.invokeDesktopExtensionWithLaunchGrants({
      registry: context.extensions,
      extensionId: claudeCode.CLAUDE_CODE_DESKTOP_EXTENSION_ID,
      methodId,
      payload: {},
      host,
      withRuntimeLock: async (operation) => await operation(),
      runningRuntime: () => state.runtime,
      replaceRuntime: async (current) => {
        replaced.push(current.handle);
        if (state.decision === "kept") {
          return "kept";
        }
        const launchGrants = await context.extensions.resolveLaunchGrants({
          projectId: current.projectId,
          controllerOrigin: current.controllerOrigin,
          instafyUserId: current.instafyUserId,
          consents: context.consents,
        });
        state.runtime = { ...current, handle: `runtime-${replaced.length + 1}`, launchGrants };
        return "replaced";
      },
    });
  return { replaced, state, invoke };
}

test("after enable, disable or locate, the runtime is replaced only when its grant changes", async () => {
  const context = setup();
  const harness = runtimeHarness(context);
  const dialogs = fakeDialogs({ pick: context.fixture.otherClaude });
  const hostA = hostFor({ consents: context.consents, dialogs });
  const hostB = hostFor({ consents: context.consents, dialogs, userId: USER_B, email: "b@example.test" });

  await harness.invoke("detect", hostA);
  await harness.invoke("status", hostA);
  assert.deepEqual(harness.replaced, []);

  await harness.invoke("enable", hostA);
  assert.deepEqual(harness.replaced, ["runtime-1"]);
  assert.notEqual(harness.state.runtime.launchGrants[0].grant, null);

  // Confirming the same program again leaves the grant as it was.
  await harness.invoke("enable", hostA);
  assert.equal(harness.replaced.length, 1);

  // Another Instafy user's change restarts nothing.
  await harness.invoke("detect", hostB);
  await harness.invoke("enable", hostB);
  await harness.invoke("disable", hostB);
  assert.equal(harness.replaced.length, 1);

  // A new path for the runtime's user does.
  await harness.invoke("locate", hostA);
  assert.equal(harness.replaced.length, 2);
  assert.equal(
    harness.state.runtime.launchGrants[0].grant.env.INSTAFY_CLAUDE_CODE_BIN,
    context.fixture.otherClaude,
  );
  await harness.invoke("locate", hostA);
  assert.equal(harness.replaced.length, 2);

  await harness.invoke("disable", hostA);
  assert.equal(harness.replaced.length, 3);
  assert.equal(harness.state.runtime.launchGrants[0].grant, null);

  // A runtime whose start was not bound to the visible session is never
  // granted, so a consent change cannot alter it.
  harness.state.runtime = { ...harness.state.runtime, instafyUserId: null };
  await harness.invoke("detect", hostA);
  assert.equal((await harness.invoke("enable", hostA)).consented, true);
  assert.equal(harness.replaced.length, 3);
});

test("confirming a moved CA file for the program in use replaces the runtime that holds the old place", async () => {
  const context = setup();
  const harness = runtimeHarness(context);
  const dialogs = fakeDialogs();
  const host = hostFor({ consents: context.consents, dialogs });
  const { claude, caFile, movedCaFile } = context.fixture;
  const runtimeEnv = () =>
    JSON.parse(harness.state.runtime.launchGrants[0].grant.env.INSTAFY_CLAUDE_CODE_ENV_JSON);
  await harness.invoke("detect", host);
  await harness.invoke("enable", host);
  assert.equal(harness.replaced.length, 1);
  assert.equal(runtimeEnv().NODE_EXTRA_CA_CERTS, caFile);

  // The person moves the CA file and the export follows it. Find reads the
  // new place, which changes no grant on its own.
  fs.renameSync(caFile, movedCaFile);
  context.useShell("movedCa");
  assert.equal((await harness.invoke("detect", host)).candidatePath, claude);
  assert.equal(harness.replaced.length, 1);

  // Use for my messages grants it, so the runtime holding the old place is replaced.
  assert.deepEqual(await harness.invoke("enable", host), {
    supported: true,
    found: true,
    path: claude,
    consented: true,
  });
  assert.ok(
    dialogs.shown[dialogs.shown.length - 1].detail.includes(`NODE_EXTRA_CA_CERTS=${movedCaFile}`),
  );
  assert.equal(harness.replaced.length, 2);
  assert.deepEqual(runtimeEnv(), {
    ...FIVE_SHELL_VALUES(context.fixture),
    NODE_EXTRA_CA_CERTS: movedCaFile,
  });
});

test("Keep working puts the consent store back and reports the change as not made", async () => {
  const context = setup();
  const harness = runtimeHarness(context);
  const hostA = hostFor({ consents: context.consents });
  await harness.invoke("detect", hostA);
  await harness.invoke("enable", hostA);
  assert.equal(harness.replaced.length, 1);
  const before = context.consents.read();

  harness.state.decision = "kept";
  await assert.rejects(harness.invoke("disable", hostA), (error) => {
    assert.equal(error.code, "desktop_extension_change_not_made");
    assert.match(error.message, /not made/);
    return true;
  });
  assert.equal(harness.replaced.length, 2);
  assert.deepEqual(context.consents.read(), before);
  assert.equal((await context.invoke("status", hostA)).consented, true);
  assert.notEqual(await context.grantFor(USER_A), null);

  // A new path the person did not keep shows nowhere.
  const dialogs = fakeDialogs({ pick: context.fixture.otherClaude });
  await assert.rejects(
    harness.invoke("locate", hostFor({ consents: context.consents, dialogs })),
    /not made/,
  );
  assert.equal((await context.invoke("status", hostA)).path, context.fixture.claude);
  assert.equal(
    (await context.grantFor(USER_A)).env.INSTAFY_CLAUDE_CODE_BIN,
    context.fixture.claude,
  );
});

test("a Locate whose login shell gave no answer offers no new values for a record Keep working puts back", async () => {
  const context = setup();
  const { claude, binDir, caFile } = context.fixture;
  // From an earlier Desktop session, so nothing was found in this one.
  writeConsentRecord(context, {
    binaryPath: claude,
    pathEntries: [binDir, "/usr/bin", "/bin"],
    env: { NODE_EXTRA_CA_CERTS: caFile },
  });
  const host = hostFor({ consents: context.consents, dialogs: fakeDialogs({ pick: claude }) });
  const on = { supported: true, found: true, path: claude, consented: true };
  const stale = {
    ...on,
    found: false,
    problem: "shell_setting_unusable",
    shellSetting: "NODE_EXTRA_CA_CERTS",
  };
  const runtime = {
    handle: "runtime-1",
    projectId: PROJECT_ID,
    controllerOrigin: CONTROLLER,
    instafyUserId: USER_A,
    launchGrants: await context.extensions.resolveLaunchGrants({
      projectId: PROJECT_ID,
      controllerOrigin: CONTROLLER,
      instafyUserId: USER_A,
      consents: context.consents,
    }),
  };
  // Turn off, held at the "still working" question while `during` runs,
  // then answered with Keep working, which puts the record back.
  const duringKeptTurnOff = async (during) => {
    let decide = null;
    const turningOff = registry
      .invokeDesktopExtensionWithLaunchGrants({
        registry: context.extensions,
        extensionId: claudeCode.CLAUDE_CODE_DESKTOP_EXTENSION_ID,
        methodId: "disable",
        payload: {},
        host,
        withRuntimeLock: async (operation) => await operation(),
        runningRuntime: () => runtime,
        replaceRuntime: () =>
          new Promise((resolve) => {
            decide = resolve;
          }),
      })
      .then(
        () => "made",
        (error) => error.code,
      );
    while (!decide) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await during();
    decide("kept");
    assert.equal(await turningOff, "desktop_extension_change_not_made");
  };
  context.useShell("noMarkers");

  // Meanwhile Locate finds no record, so it reads the login shell, which
  // gives no answer. Put back beside it, the record offers nothing new.
  await duringKeptTurnOff(async () => {
    assert.equal((await context.invoke("locate", host)).consented, false);
  });
  assert.deepEqual(await context.invoke("status", host), on);
  fs.rmSync(caFile);
  assert.deepEqual(await context.invoke("status", host), stale);

  // Nor when Locate takes what a Find whose login shell gave no answer read.
  fs.writeFileSync(caFile, "fixture CA bundle\n");
  fs.chmodSync(caFile, 0o644);
  await duringKeptTurnOff(async () => {
    assert.equal((await context.invoke("detect", host)).consented, false);
    assert.equal((await context.invoke("locate", host)).consented, false);
  });
  fs.rmSync(caFile);
  assert.deepEqual(await context.invoke("status", host), stale);
});

test("a status read during a consent change waits for it, and shows it undone when the work is kept", async () => {
  const context = setup();
  const extensionId = claudeCode.CLAUDE_CODE_DESKTOP_EXTENSION_ID;
  assert.equal(context.extensions.methodIsReadOnly(extensionId, "status"), true);
  for (const method of ["detect", "locate", "enable", "disable"]) {
    assert.equal(context.extensions.methodIsReadOnly(extensionId, method), false, method);
  }
  // One runtime lock, first come first served, as main.ts's.
  let tail = Promise.resolve();
  const withRuntimeLock = async (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  let decide = null;
  const runtime = {
    handle: "runtime-1",
    projectId: PROJECT_ID,
    controllerOrigin: CONTROLLER,
    instafyUserId: USER_A,
    launchGrants: context.extensions.launchGrantsWithoutValues(),
  };
  const hostA = hostFor({ consents: context.consents });
  const invoke = (methodId) =>
    registry.invokeDesktopExtensionWithLaunchGrants({
      registry: context.extensions,
      extensionId,
      methodId,
      payload: {},
      host: hostA,
      withRuntimeLock,
      runningRuntime: () => runtime,
      // The "still working" question, which the person has not answered yet.
      replaceRuntime: () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    });

  await invoke("detect");
  const enabling = invoke("enable").then(
    () => "made",
    (error) => error.code,
  );
  while (!decide) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The record is written while the person decides.
  assert.equal((await context.invoke("status", hostA)).consented, true);
  const reading = invoke("status");
  decide("kept");
  assert.equal(await enabling, "desktop_extension_change_not_made");
  assert.deepEqual(await reading, {
    supported: true,
    found: true,
    path: context.fixture.claude,
    consented: false,
  });
});
