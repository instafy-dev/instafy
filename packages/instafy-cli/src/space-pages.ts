import fs from "node:fs";
import path from "node:path";

// The space's record of its pages: each page's folder with the chat that made it, its title and how it is served. A
// turn that may write files is told the space's pages from it, each made in its own chat or in another, so it never
// takes another chat's page for its own (the runtime agent reads it, `jobs/space_pages.rs`, and writes down a page a
// wake starts again that it does not hold yet).
//
// It is kept with the space's files, under `.instafy/` (never saved, published, listed or copied into a scoped
// worker's copy), not with the CLI's own state in the home folder: a stopped space's next machine starts with a new
// home folder, and the record has to be there for the next turn. It does not outlast the machine's disk, though: no
// save holds it, so a hosted space starts without it after a release or once its idle checkout is cloned again. The
// server keeps which chat made each page (the controller's `previews/pages.rs`) and says so when a card is posted;
// this file is the copy on this machine, which the runtime fills in again from the server before each turn.
//
// Which chat a page is written down with, the first time its folder's card is opened:
// - the chat the server holds for the folder, when it answers with one (or with none: a page nobody's);
// - else the chat this file already holds for the folder;
// - else the chat the card went to, but only for a folder made in the turn that opens it. A folder that was there
//   before that turn is written down with no chat, as a wake writes one down: with the file gone, the first chat to
//   open another chat's page used to become its maker, and the chat that made it could no longer change it.
export const PAGES_RECORD_DIR = path.join(".instafy", "pages");
export const PAGES_RECORD_FILE = path.join(PAGES_RECORD_DIR, "pages.json");
// The record's folder holds nothing a save, a status or a person's own git should see.
const PAGES_RECORD_IGNORE = "*\n";
const MAX_RECORDED = 100;
// The folders that were in the workspace when the turn began (`jobs/space_pages.rs` writes it before a turn that may
// write files): `{ "version": 1, "folders": ["sites", "sites/porto", …], "complete": true }`, each folder at most two
// names deep.
export const TURN_FOLDERS_FILE = path.join(PAGES_RECORD_DIR, "turn-folders.json");
const TURN_FOLDERS_DEPTH = 2;

export type PageFolderAge = "new" | "existing";

export type RecordedPage = {
  folder: string;
  title: string;
  // The chat that made the page. Absent when nothing says which chat made it (a page a wake wrote down, or one whose
  // folder was there before the turn that first opened its card): no later open claims it, and no chat is kept from
  // changing it.
  conversationId?: string;
  // How the site is served: its program's name and first argument (`["instafy", "bind"]`, `["uw", "host"]`). The
  // runtime lists only pages made for the person, whose site Instafy's page server or an installed skill's command
  // serves, and never the person's own app.
  server: string[];
  openedAt: string;
};

function readPages(file: string): RecordedPage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const pages = (parsed as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) return [];
  return pages.filter(
    (page): page is RecordedPage =>
      !!page && typeof page === "object" && typeof (page as RecordedPage).folder === "string",
  );
}

/** The program's name and its first argument: `["instafy", "bind"]` for `instafy bind serve . --port {port}`. */
export function serverOf(argv: string[]): string[] {
  const [program, first] = argv;
  return program === undefined ? [] : [path.basename(program), ...(first === undefined ? [] : [first])];
}

/** How the record says the page in `folder` is served (`serverOf` its command), or null when it holds no such page. */
export function recordedServer(root: string, folder: string): string[] | null {
  const page = readPages(path.join(root, PAGES_RECORD_FILE)).find((entry) => entry.folder === folder);
  if (!page) return null;
  return Array.isArray(page.server) ? page.server.filter((word) => typeof word === "string") : [];
}

/** A page's folder as the record keys it, or null for the workspace itself and for a folder outside it. */
export function pageFolder(raw: string): string | null {
  const folder = raw.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!folder || folder === "." || folder === ".." || folder.startsWith("../") || path.isAbsolute(folder)) return null;
  return folder;
}

/**
 * Whether the page folder `folder` (relative to the space's workspace `root`) was made in the turn that opens it
 * (`new`) or was there before that turn began (`existing`), from the folders the runtime wrote down as the turn began.
 * A folder deeper than that list goes is read by its first two names. Without that list (no turn wrote one, or it is
 * not whole), or under a folder the list leaves out (a hidden one, `node_modules`), nothing says the folder is new: it
 * reads as `existing`, and its open claims it for no chat.
 */
export function pageFolderAge(root: string, folder: string): PageFolderAge {
  let listed: unknown;
  try {
    listed = JSON.parse(fs.readFileSync(path.join(root, TURN_FOLDERS_FILE), "utf8"));
  } catch {
    return "existing";
  }
  const { folders, complete } = (listed ?? {}) as { folders?: unknown; complete?: unknown };
  if (complete !== true || !Array.isArray(folders)) return "existing";
  const names = folder.split("/");
  // The list leaves out hidden folders and `node_modules`: nothing says a folder under one is new.
  if (names.slice(0, TURN_FOLDERS_DEPTH).some((name) => name.startsWith(".") || name === "node_modules")) return "existing";
  // Any part of the path that was there: a folder made inside one that was there counts as made in this turn only
  // when the list goes that deep.
  for (let depth = 1; depth <= Math.min(names.length, TURN_FOLDERS_DEPTH); depth += 1) {
    const there = folders.includes(names.slice(0, depth).join("/"));
    if (!there) return "new";
    if (depth === names.length) return "existing";
  }
  return "existing";
}

/**
 * Writes down the page in `folder` (relative to the space's workspace `root`) whose card this open posted to
 * `opening`. Its chat is the one the server holds for the folder (`held`: a chat, or null for a page nobody's), else
 * the one the record already keeps for it, else `opening` for a folder made in this turn (`age` "new") and no chat for
 * one that was there before. A folder that is gone from the workspace leaves the record. The workspace itself is the
 * person's own site, no page a chat made, and is not written down.
 */
export function recordPage(
  root: string,
  page: {
    folder: string;
    title: string;
    argv: string[];
    opening: string | undefined;
    age: PageFolderAge;
    held?: { conversationId: string | null };
  },
  now: Date = new Date(),
): RecordedPage | null {
  const folder = pageFolder(page.folder);
  if (folder === null) return null;
  const file = path.join(root, PAGES_RECORD_FILE);
  const pages = readPages(file);
  const earlier = pages.find((entry) => entry.folder === folder);
  const madeIn = page.held
    ? (page.held.conversationId ?? undefined)
    : earlier
      ? earlier.conversationId
      : page.age === "new"
        ? page.opening
        : undefined;
  const recorded: RecordedPage = {
    folder,
    title: page.title,
    ...(madeIn ? { conversationId: madeIn } : {}),
    server: serverOf(page.argv),
    openedAt: now.toISOString(),
  };
  const kept = pages.filter((entry) => entry.folder !== folder && isDirectory(path.join(root, entry.folder)));
  const dir = path.join(root, PAGES_RECORD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, PAGES_RECORD_IGNORE);
  const temporary = `${file}.${process.pid}.tmp`;
  const body = { version: 1, pages: [recorded, ...kept].slice(0, MAX_RECORDED) };
  fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return recorded;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
