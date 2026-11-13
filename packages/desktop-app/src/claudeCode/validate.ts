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
