import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INSTAFY_ENV_DIR_VARIABLE = "INSTAFY_ENV_DIR";

export const LIVE_ENV_PATHS = Object.freeze([
  ".env.hetzner",
  ".env.stripe",
  ".env.supabase",
  "docker/.env.local",
  "packages/frontend/.env.production.local",
  "supabase/.env.dev.local",
]);

export const OPTIONAL_PROTECTED_ENV_PATHS = Object.freeze([
  ".env.supabase.local",
  ".env.user",
  "packages/frontend/.env.local",
]);

export const PROTECTED_ENV_PATHS = Object.freeze([
  ...LIVE_ENV_PATHS,
  ...OPTIONAL_PROTECTED_ENV_PATHS,
]);

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(left, right) {
  return isPathInside(left, right) || isPathInside(right, left);
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeRelativeEnvPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("private env path must be a non-empty repository-relative path");
  }
  const normalized = path.normalize(relativePath);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`private env path must stay inside its configured root: ${relativePath}`);
  }
  return normalized;
}

export function resolveInstafyEnvDir({
  repoRoot,
  processEnv = process.env,
  required = false,
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new Error("repoRoot is required");
  }
  const configured = String(processEnv[INSTAFY_ENV_DIR_VARIABLE] ?? "").trim();
  if (!configured) {
    if (required) {
      throw new Error(
        `${INSTAFY_ENV_DIR_VARIABLE} must be set to an absolute path outside the repository`,
      );
    }
    return null;
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(`${INSTAFY_ENV_DIR_VARIABLE} must be an absolute path`);
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedEnvDir = path.resolve(configured);
  const forbiddenRoots = [resolvedRepoRoot];
  if (path.basename(resolvedRepoRoot) === "instafy-internal") {
    forbiddenRoots.push(path.join(path.dirname(resolvedRepoRoot), "instafy"));
  }
  if (
    resolvedEnvDir === path.parse(resolvedEnvDir).root ||
    resolvedEnvDir === path.resolve(os.homedir())
  ) {
    throw new Error(`${INSTAFY_ENV_DIR_VARIABLE} must name a dedicated directory`);
  }
  if (forbiddenRoots.some((root) => pathsOverlap(resolvedEnvDir, root))) {
    throw new Error(`${INSTAFY_ENV_DIR_VARIABLE} must point outside both Instafy repositories`);
  }

  const rootResult = inspectProtectedPath(resolvedEnvDir, { directory: true });
  if (!rootResult.ok) {
    throw new Error(
      `${INSTAFY_ENV_DIR_VARIABLE} must name an existing protected directory: ${rootResult.reason}`,
    );
  }
  const realEnvDir = fs.realpathSync(resolvedEnvDir);
  const realForbiddenRoots = forbiddenRoots
    .filter(pathExists)
    .map((root) => fs.realpathSync(root));
  if (realForbiddenRoots.some((root) => pathsOverlap(realEnvDir, root))) {
    throw new Error(
      `${INSTAFY_ENV_DIR_VARIABLE} must resolve outside both Instafy repositories`,
    );
  }
  return realEnvDir;
}

export function resolvePrivateEnvPath({
  repoRoot,
  relativePath,
  processEnv = process.env,
} = {}) {
  const normalizedRelativePath = normalizeRelativeEnvPath(relativePath);
  const envDir = resolveInstafyEnvDir({ repoRoot, processEnv });
  const resolvedPath = path.join(
    envDir ?? path.resolve(repoRoot),
    normalizedRelativePath,
  );
  if (envDir && pathExists(resolvedPath)) {
    const inspection = inspectProtectedEnvFile(envDir, resolvedPath);
    if (!inspection.ok) {
      throw new Error(
        `private env path is not protected: ${normalizedRelativePath}: ${inspection.reason}`,
      );
    }
  }
  return resolvedPath;
}

function permissionFailure(stat, label) {
  if (process.platform === "win32") {
    return null;
  }
  const actual = stat.mode & 0o777;
  return (actual & 0o077) === 0
    ? null
    : `${label} permissions are too broad (${actual.toString(8).padStart(3, "0")})`;
}

function inspectProtectedPath(filePath, { directory }) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: `cannot inspect metadata: ${error?.message ?? error}` };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, reason: "symbolic links are not allowed" };
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    return { ok: false, reason: directory ? "not a directory" : "not a regular file" };
  }
  if (!directory && stat.nlink !== 1) {
    return { ok: false, reason: "hard links are not allowed" };
  }
  const permissionProblem = permissionFailure(stat, directory ? "directory" : "file");
  if (permissionProblem) {
    return { ok: false, reason: permissionProblem };
  }
  return {
    ok: true,
    reason:
      process.platform === "win32"
        ? "regular path"
        : directory
          ? "mode 700 or stricter"
          : "mode 600 or stricter",
  };
}

function inspectProtectedEnvFile(envDir, filePath) {
  const relativeParent = path.relative(envDir, path.dirname(filePath));
  let current = envDir;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const directoryResult = inspectProtectedPath(current, { directory: true });
    if (!directoryResult.ok) {
      return {
        ok: false,
        reason: `parent directory ${path.relative(envDir, current)}: ${directoryResult.reason}`,
      };
    }
  }
  return inspectProtectedPath(filePath, { directory: false });
}

function ensureSafeParentDirectories(baseRoot, filePath, { protectedPermissions }) {
  const resolvedBase = fs.realpathSync(baseRoot);
  const parent = path.dirname(filePath);
  const relativeParent = path.relative(resolvedBase, parent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error(`private env path escapes its configured root: ${filePath}`);
  }

  let current = resolvedBase;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`private env parent is not a normal directory: ${current}`);
    }
    if (protectedPermissions) {
      const permissionProblem = permissionFailure(stat, "directory");
      if (permissionProblem) {
        throw new Error(`private env parent is not protected: ${current}: ${permissionProblem}`);
      }
    }
    const realCurrent = fs.realpathSync(current);
    if (!isPathInside(realCurrent, resolvedBase)) {
      throw new Error(`private env parent resolves outside its configured root: ${current}`);
    }
  }
}

export function writePrivateEnvFileSync({
  repoRoot,
  relativePath,
  data,
  encoding = "utf8",
  flag = "w",
  processEnv = process.env,
} = {}) {
  if (flag !== "w" && flag !== "wx") {
    throw new Error(`unsupported private env write flag: ${flag}`);
  }
  const normalizedRelativePath = normalizeRelativeEnvPath(relativePath);
  const envDir = resolveInstafyEnvDir({ repoRoot, processEnv });
  const baseRoot = envDir ?? fs.realpathSync(path.resolve(repoRoot));
  const filePath = path.join(baseRoot, normalizedRelativePath);
  ensureSafeParentDirectories(baseRoot, filePath, {
    protectedPermissions: Boolean(envDir),
  });

  let existing = null;
  try {
    existing = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`private env destination is not a normal file: ${filePath}`);
    }
    if (existing.nlink !== 1) {
      throw new Error(`private env destination must not be hard linked: ${filePath}`);
    }
    if (envDir) {
      const permissionProblem = permissionFailure(existing, "file");
      if (permissionProblem) {
        throw new Error(
          `private env destination is not protected: ${filePath}: ${permissionProblem}`,
        );
      }
    }
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const exclusive = flag === "wx" ? fs.constants.O_EXCL : 0;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      exclusive |
      noFollow,
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error(`private env destination changed during write: ${filePath}`);
    }
    fs.writeFileSync(descriptor, data, { encoding });
    if (process.platform !== "win32") {
      fs.fchmodSync(descriptor, 0o600);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return filePath;
}

export function auditPrivateEnvLayout({
  repoRoot,
  processEnv = process.env,
  liveEnvPaths = LIVE_ENV_PATHS,
  optionalProtectedEnvPaths = OPTIONAL_PROTECTED_ENV_PATHS,
} = {}) {
  const envDir = resolveInstafyEnvDir({ repoRoot, processEnv, required: true });
  const rootResult = inspectProtectedPath(envDir, { directory: true });
  const required = new Set(
    liveEnvPaths.map((relativePath) => normalizeRelativeEnvPath(relativePath)),
  );
  const protectedPaths = [
    ...required,
    ...optionalProtectedEnvPaths.map((relativePath) =>
      normalizeRelativeEnvPath(relativePath),
    ),
  ];
  if (new Set(protectedPaths).size !== protectedPaths.length) {
    throw new Error("protected private env paths must be unique");
  }
  const files = protectedPaths.map((normalizedRelativePath) => {
    const externalPath = path.join(envDir, normalizedRelativePath);
    const legacyPath = path.join(path.resolve(repoRoot), normalizedRelativePath);
    const isRequired = required.has(normalizedRelativePath);
    const external =
      !isRequired && !pathExists(externalPath)
        ? { ok: true, reason: "not present (optional protected path)" }
        : inspectProtectedEnvFile(envDir, externalPath);
    return {
      relativePath: normalizedRelativePath,
      externalPath,
      external,
      legacyPresent: pathExists(legacyPath),
      required: isRequired,
    };
  });
  return {
    envDir,
    root: rootResult,
    files,
    ok:
      rootResult.ok &&
      files.every((entry) => entry.external.ok && !entry.legacyPresent),
  };
}
