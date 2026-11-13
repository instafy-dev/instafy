import fs from "node:fs";
import path from "node:path";

import { hasControlCharacter } from "./detect";

/**
 * macOS's `admin` group. Its members are root-equivalent through sudo, and
 * Homebrew makes /opt/homebrew/bin writable by it, so a writer in that group
 * is allowed where any other writer is not.
 */
export const MACOS_ADMIN_GROUP_ID = 80;
const MAX_SYMLINK_HOPS = 40;

export type ClaudeCodeBinaryProblem =
  | "relative_path"
  | "missing"
  | "not_a_file"
  | "not_executable"
  | "foreign_owner"
  | "writable_by_others"
  | "inside_instafy_folder"
  | "too_many_links";

export type ClaudeCodeFileStats = {
  uid: number;
  gid: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** The few calls validation makes. None of them opens, runs or hashes the file. */
export type ClaudeCodeFileSystem = {
  lstatSync(file: string): ClaudeCodeFileStats;
  readlinkSync(file: string): string;
  realpathSync(file: string): string;
  accessSync(file: string, mode?: number): void;
};

export type ClaudeCodeBinaryValidation =
  | Readonly<{ ok: true; path: string; target: string }>
  | Readonly<{ ok: false; problem: ClaudeCodeBinaryProblem }>;

export type ClaudeCodeBinaryValidationOptions = {
  /** The effective uid; files must be owned by it or by root. */
  uid: number;
  adminGroupId: number | null;
  /** Folders the binary may not live in: the workspace root, each space's folder, the app bundle and ~/.instafy. */
  desktopOwnedPaths: readonly string[];
  /** macOS folders compare names ignoring case. */
  caseInsensitivePaths: boolean;
  fs?: ClaudeCodeFileSystem;
};

function refuse(problem: ClaudeCodeBinaryProblem): ClaudeCodeBinaryValidation {
  return Object.freeze({ ok: false as const, problem });
}

function canonicalPath(files: ClaudeCodeFileSystem, file: string): string {
  try {
    return files.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function isInside(candidate: string, root: string, caseInsensitive: boolean): boolean {
  const child = caseInsensitive ? candidate.toLowerCase() : candidate;
  const parent = caseInsensitive ? root.toLowerCase() : root;
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Check, without running, opening or hashing it, that a path names a program
 * only this OS account (or root, or the admin group) can change: the target is
 * a regular executable file; it, its folder, the chosen path's own folder and
 * every symlink on the way (with its folder) are owned by this user or root
 * and writable by nobody else; and none of them is inside a folder Instafy
 * owns. The chosen path is kept as given, so an update that moves a symlink's
 * target keeps working; runtime-agent checks it again before each turn.
 */
export function validateClaudeCodeBinary(
  chosenPath: unknown,
  options: ClaudeCodeBinaryValidationOptions,
): ClaudeCodeBinaryValidation {
  const files = options.fs ?? fs;
  if (
    typeof chosenPath !== "string" ||
    !chosenPath.startsWith("/") ||
    hasControlCharacter(chosenPath)
  ) {
    return refuse("relative_path");
  }
  const ownedPaths = options.desktopOwnedPaths
    .filter((entry) => typeof entry === "string" && entry.startsWith("/"))
    .map((entry) => canonicalPath(files, entry));
  const insideOwnedPath = (file: string) =>
    ownedPaths.some((root) => isInside(file, root, options.caseInsensitivePaths));
  const ownedByUserOrRoot = (stats: ClaudeCodeFileStats) =>
    stats.uid === options.uid || stats.uid === 0;
  const writableByOthers = (stats: ClaudeCodeFileStats) =>
    (stats.mode & 0o002) !== 0 ||
    ((stats.mode & 0o020) !== 0 && stats.gid !== options.adminGroupId);

  const folders = new Set<string>();
  let current = chosenPath;
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    let folder: string;
    try {
      folder = files.realpathSync(path.dirname(current));
    } catch {
      return refuse("missing");
    }
    const entry = path.join(folder, path.basename(current));
    folders.add(folder);
    if (insideOwnedPath(entry)) {
      return refuse("inside_instafy_folder");
    }
    let stats: ClaudeCodeFileStats;
    try {
      stats = files.lstatSync(entry);
    } catch {
      return refuse("missing");
    }
    if (stats.isSymbolicLink()) {
      if (!ownedByUserOrRoot(stats)) {
        return refuse("foreign_owner");
      }
      let target: string;
      try {
        target = files.readlinkSync(entry);
      } catch {
        return refuse("missing");
      }
      current = path.resolve(folder, target);
      continue;
    }
    if (!stats.isFile()) {
      return refuse("not_a_file");
    }
    if (!ownedByUserOrRoot(stats)) {
      return refuse("foreign_owner");
    }
    if (writableByOthers(stats)) {
      return refuse("writable_by_others");
    }
    if ((stats.mode & 0o111) === 0) {
      return refuse("not_executable");
    }
    try {
      files.accessSync(entry, fs.constants.X_OK);
    } catch {
      return refuse("not_executable");
    }
    for (const visited of folders) {
      let folderStats: ClaudeCodeFileStats;
      try {
        folderStats = files.lstatSync(visited);
      } catch {
        return refuse("missing");
      }
      if (!folderStats.isDirectory()) {
        return refuse("not_a_file");
      }
      if (!ownedByUserOrRoot(folderStats)) {
        return refuse("foreign_owner");
      }
      if (writableByOthers(folderStats)) {
        return refuse("writable_by_others");
      }
    }
    return Object.freeze({ ok: true as const, path: chosenPath, target: entry });
  }
  return refuse("too_many_links");
}

/**
 * The login-shell values that name a place on disk, and what each must be
 * there (D26). runtime-agent checks a granted one before every turn, and
 * refuses the whole grant when it fails.
 */
export const CLAUDE_CODE_SHELL_SETTING_KINDS = Object.freeze({
  CLAUDE_CONFIG_DIR: "directory",
  NODE_EXTRA_CA_CERTS: "file",
} as const);

export type ClaudeCodeShellSetting = keyof typeof CLAUDE_CODE_SHELL_SETTING_KINDS;

export type ClaudeCodeShellSettingValidationOptions = {
  /** The effective uid; the place and every link on the way must be owned by it or by root. */
  uid: number;
  /** Folders the place may not be in, as for the program. */
  desktopOwnedPaths: readonly string[];
  caseInsensitivePaths: boolean;
  fs?: ClaudeCodeFileSystem;
};

function pathSteps(value: string): string[] {
  return value.split("/").filter((step) => step.length > 0 && step !== ".");
}

/**
 * Resolve an absolute path one component at a time, as the kernel does and
 * runtime-agent's own walk does, and note every symlink met on the way where
 * it physically is. Null when a component is missing or there are too many.
 */
function walkSymlinks(
  files: ClaudeCodeFileSystem,
  absolutePath: string,
): { target: string; links: string[] } | null {
  const pending = pathSteps(absolutePath);
  const links: string[] = [];
  let current = "/";
  while (pending.length > 0) {
    const step = pending.shift() as string;
    if (step === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, step);
    let stats: ClaudeCodeFileStats;
    let destination: string;
    try {
      stats = files.lstatSync(next);
      if (!stats.isSymbolicLink()) {
        current = next;
        continue;
      }
      if (links.length >= MAX_SYMLINK_HOPS) {
        return null;
      }
      destination = files.readlinkSync(next);
    } catch {
      return null;
    }
    links.push(next);
    if (destination.startsWith("/")) {
      current = "/";
    }
    pending.unshift(...pathSteps(destination));
  }
  return { target: current, links };
}

/**
 * Check, without opening it, a login-shell `CLAUDE_CONFIG_DIR` (a directory)
 * or `NODE_EXTRA_CA_CERTS` (a regular file) by runtime-agent's rule for a
 * granted one (3.2, D26): an absolute path; every symlink on the way owned by
 * this user or root; the place itself owned by this user or root and writable
 * by neither its group nor anyone else; and none of them inside a folder
 * Instafy owns. A value that fails would make every turn refuse, so Desktop
 * neither offers nor grants it.
 */
export function claudeCodeShellSettingIsUsable(
  setting: ClaudeCodeShellSetting,
  value: unknown,
  options: ClaudeCodeShellSettingValidationOptions,
): boolean {
  const files = options.fs ?? fs;
  if (typeof value !== "string" || !value.startsWith("/") || hasControlCharacter(value)) {
    return false;
  }
  const ownedPaths = options.desktopOwnedPaths
    .filter((entry) => typeof entry === "string" && entry.startsWith("/"))
    .flatMap((entry) => [path.resolve(entry), canonicalPath(files, entry)]);
  const insideOwnedPath = (file: string) =>
    ownedPaths.some((root) => isInside(file, root, options.caseInsensitivePaths));
  const ownedByUserOrRoot = (stats: ClaudeCodeFileStats) =>
    stats.uid === options.uid || stats.uid === 0;
  // As given, compared component by component as runtime-agent compares it:
  // a value that only passes through an owned folder still counts as inside.
  const steps = pathSteps(value);
  const firstParent = steps.indexOf("..");
  if (insideOwnedPath(`/${(firstParent === -1 ? steps : steps.slice(0, firstParent)).join("/")}`)) {
    return false;
  }
  const walk = walkSymlinks(files, value);
  if (!walk || insideOwnedPath(walk.target)) {
    return false;
  }
  try {
    for (const link of walk.links) {
      if (insideOwnedPath(link) || !ownedByUserOrRoot(files.lstatSync(link))) {
        return false;
      }
    }
    const stats = files.lstatSync(walk.target);
    const rightKind =
      CLAUDE_CODE_SHELL_SETTING_KINDS[setting] === "directory" ? stats.isDirectory() : stats.isFile();
    return rightKind && ownedByUserOrRoot(stats) && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** The first login-shell value in `env` that Desktop can't use, in the order runtime-agent checks them. */
export function findUnusableClaudeCodeShellSetting(
  env: Readonly<Partial<Record<string, string>>>,
  options: ClaudeCodeShellSettingValidationOptions,
): ClaudeCodeShellSetting | null {
  for (const setting of Object.keys(CLAUDE_CODE_SHELL_SETTING_KINDS) as ClaudeCodeShellSetting[]) {
    const value = env[setting];
    if (value !== undefined && !claudeCodeShellSettingIsUsable(setting, value, options)) {
      return setting;
    }
  }
  return null;
}
