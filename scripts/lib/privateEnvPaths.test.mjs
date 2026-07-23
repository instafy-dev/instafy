import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditPrivateEnvLayout,
  LIVE_ENV_PATHS,
  OPTIONAL_PROTECTED_ENV_PATHS,
  PROTECTED_ENV_PATHS,
  resolveInstafyEnvDir,
  resolvePrivateEnvPath,
  writePrivateEnvFileSync,
} from "./privateEnvPaths.mjs";

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-private-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeProtectedFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, "TEST_KEY=test-value\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(filePath), 0o700);
    fs.chmodSync(filePath, 0o600);
  }
}

test("uses legacy repository paths only when INSTAFY_ENV_DIR is unset", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot);

  assert.equal(
    resolvePrivateEnvPath({
      repoRoot,
      relativePath: "docker/.env.local",
      processEnv: {},
    }),
    path.join(repoRoot, "docker", ".env.local"),
  );
});

test("mirrors repository-relative env paths below an external absolute root", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  const envDir = path.join(root, "private-env");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(envDir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(envDir, 0o700);

  assert.equal(
    resolvePrivateEnvPath({
      repoRoot,
      relativePath: "supabase/.env.dev.local",
      processEnv: { INSTAFY_ENV_DIR: envDir },
    }),
    path.join(fs.realpathSync(envDir), "supabase", ".env.dev.local"),
  );
});

test("rejects relative, missing, overlapping, in-repository, and traversing configured paths", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot);

  assert.throws(
    () =>
      resolveInstafyEnvDir({
        repoRoot,
        processEnv: { INSTAFY_ENV_DIR: "relative" },
    }),
    /absolute path/,
  );
  assert.throws(
    () =>
      resolveInstafyEnvDir({
        repoRoot,
        processEnv: { INSTAFY_ENV_DIR: path.join(root, "missing") },
      }),
    /existing protected directory/,
  );
  assert.throws(
    () =>
      resolveInstafyEnvDir({
        repoRoot,
        processEnv: { INSTAFY_ENV_DIR: path.join(repoRoot, "secrets") },
      }),
    /outside both Instafy repositories/,
  );
  assert.throws(
    () =>
      resolvePrivateEnvPath({
        repoRoot,
        relativePath: "../secret",
        processEnv: {},
      }),
    /stay inside/,
  );
  assert.throws(
    () =>
      resolveInstafyEnvDir({
        repoRoot,
        processEnv: { INSTAFY_ENV_DIR: path.parse(repoRoot).root },
    }),
    /dedicated directory/,
  );
  assert.throws(
    () =>
      resolveInstafyEnvDir({
        repoRoot,
        processEnv: { INSTAFY_ENV_DIR: root },
      }),
    /outside both Instafy repositories/,
  );
});

test("rejects the known sibling public checkout from the internal repository", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "instafy-internal");
  const publicRoot = path.join(root, "instafy");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(publicRoot);

  assert.throws(
    () =>
      resolveInstafyEnvDir({
        repoRoot,
        processEnv: { INSTAFY_ENV_DIR: path.join(publicRoot, ".secrets") },
      }),
    /outside both Instafy repositories/,
  );
});

test("rejects a nonexistent env root reached through a symlink into the repository", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "instafy-internal");
  const outside = path.join(root, "outside");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(outside);
  fs.symlinkSync(repoRoot, path.join(outside, "through-link"));

  assert.throws(
    () =>
      resolvePrivateEnvPath({
        repoRoot,
        relativePath: ".env.supabase.local",
        processEnv: {
          INSTAFY_ENV_DIR: path.join(outside, "through-link", "not-yet-created"),
        },
      }),
    /existing protected directory/,
  );
});

test("metadata-only audit accepts protected external files and absent legacy copies", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  const envDir = path.join(root, "private-env");
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  fs.mkdirSync(envDir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(envDir, 0o700);
  for (const relativePath of LIVE_ENV_PATHS) {
    writeProtectedFile(path.join(envDir, relativePath));
  }

  const result = auditPrivateEnvLayout({
    repoRoot,
    processEnv: { INSTAFY_ENV_DIR: envDir },
  });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, PROTECTED_ENV_PATHS.length);
  assert.deepEqual(
    result.files
      .filter((entry) => !entry.required)
      .map((entry) => entry.relativePath),
    OPTIONAL_PROTECTED_ENV_PATHS,
  );
  assert.equal(
    result.files
      .filter((entry) => !entry.required)
      .every((entry) => entry.external.reason.includes("optional protected path")),
    true,
  );
});

test("audit rejects legacy copies, permissive files, and symlinks", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  const envDir = path.join(root, "private-env");
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  fs.mkdirSync(envDir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(envDir, 0o700);
  for (const relativePath of LIVE_ENV_PATHS) {
    writeProtectedFile(path.join(envDir, relativePath));
  }

  writeProtectedFile(path.join(repoRoot, LIVE_ENV_PATHS[0]));
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(envDir, LIVE_ENV_PATHS[1]), 0o644);
  }
  const target = path.join(envDir, LIVE_ENV_PATHS[2]);
  fs.unlinkSync(target);
  fs.symlinkSync(path.join(envDir, LIVE_ENV_PATHS[0]), target);

  const result = auditPrivateEnvLayout({
    repoRoot,
    processEnv: { INSTAFY_ENV_DIR: envDir },
  });
  assert.equal(result.ok, false);
  assert.equal(result.files[0].legacyPresent, true);
  if (process.platform !== "win32") {
    assert.match(result.files[1].external.reason, /permissions are too broad/);
  }
  assert.match(result.files[2].external.reason, /symbolic links/);
});

test("audit rejects a permissive or symlinked intermediate directory", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  const envDir = path.join(root, "private-env");
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  fs.mkdirSync(envDir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(envDir, 0o700);
  for (const relativePath of LIVE_ENV_PATHS) {
    writeProtectedFile(path.join(envDir, relativePath));
  }

  if (process.platform !== "win32") {
    fs.chmodSync(path.join(envDir, "docker"), 0o755);
    const permissiveResult = auditPrivateEnvLayout({
      repoRoot,
      processEnv: { INSTAFY_ENV_DIR: envDir },
    });
    assert.match(permissiveResult.files[3].external.reason, /parent directory docker/);
    fs.chmodSync(path.join(envDir, "docker"), 0o700);
  }

  const packagesDir = path.join(envDir, "packages");
  const packagesBackup = path.join(envDir, "packages-real");
  fs.renameSync(packagesDir, packagesBackup);
  fs.symlinkSync(packagesBackup, packagesDir);
  const symlinkResult = auditPrivateEnvLayout({
    repoRoot,
    processEnv: { INSTAFY_ENV_DIR: envDir },
  });
  assert.match(symlinkResult.files[4].external.reason, /parent directory packages/);
});

test("audit rejects unsafe optional credential files when they are present", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  const envDir = path.join(root, "private-env");
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  fs.mkdirSync(envDir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(envDir, 0o700);
  for (const relativePath of LIVE_ENV_PATHS) {
    writeProtectedFile(path.join(envDir, relativePath));
  }
  const redirected = path.join(repoRoot, "redirected-secret");
  writeProtectedFile(redirected);
  fs.symlinkSync(redirected, path.join(envDir, ".env.supabase.local"));

  const result = auditPrivateEnvLayout({
    repoRoot,
    processEnv: { INSTAFY_ENV_DIR: envDir },
  });
  const optional = result.files.find(
    (entry) => entry.relativePath === ".env.supabase.local",
  );
  assert.equal(result.ok, false);
  assert.match(optional.external.reason, /symbolic links/);
});

test("protected writer creates mode-600 files and refuses symlink destinations", (t) => {
  const root = makeTempRoot(t);
  const repoRoot = path.join(root, "repo");
  const envDir = path.join(root, "private-env");
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  fs.mkdirSync(envDir, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(envDir, 0o700);
  const processEnv = { INSTAFY_ENV_DIR: envDir };

  const written = writePrivateEnvFileSync({
    repoRoot,
    relativePath: ".env.supabase.local",
    data: "SERVICE_ROLE_KEY=fixture\n",
    processEnv,
  });
  assert.equal(fs.readFileSync(written, "utf8"), "SERVICE_ROLE_KEY=fixture\n");
  if (process.platform !== "win32") {
    assert.equal(fs.lstatSync(written).mode & 0o777, 0o600);
  }
  assert.throws(
    () =>
      writePrivateEnvFileSync({
        repoRoot,
        relativePath: ".env.supabase.local",
        data: "SERVICE_ROLE_KEY=exclusive-overwrite\n",
        flag: "wx",
        processEnv,
      }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(written, "utf8"), "SERVICE_ROLE_KEY=fixture\n");

  fs.unlinkSync(written);
  const redirected = path.join(repoRoot, "redirected-secret");
  writeProtectedFile(redirected);
  fs.symlinkSync(redirected, written);
  assert.throws(
    () =>
      resolvePrivateEnvPath({
        repoRoot,
        relativePath: ".env.supabase.local",
        processEnv,
      }),
    /private env path is not protected.*symbolic links/u,
  );
  assert.throws(
    () =>
      writePrivateEnvFileSync({
        repoRoot,
        relativePath: ".env.supabase.local",
        data: "SERVICE_ROLE_KEY=changed\n",
        processEnv,
      }),
    /not a normal file/,
  );
  assert.equal(fs.readFileSync(redirected, "utf8"), "TEST_KEY=test-value\n");
});

test("runtime Compose resolves its env file from the same external root", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const compose = fs.readFileSync(
    path.join(repoRoot, "docker", "docker-compose.runtime.yml"),
    "utf8",
  );
  assert.match(
    compose,
    /env_file:\s*\n\s+- \$\{INSTAFY_ENV_DIR:-\.\.\}\/docker\/\.env\.local/u,
  );
  assert.doesNotMatch(compose, /INSTAFY_DOCKER_ENV_FILE/u);
});
