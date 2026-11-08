import fs from "node:fs";
import path from "node:path";

// The space's record of its pages: each page's folder with the chat its card went to the first time that folder's card
// was opened, its title and how it is served. A turn that may write files is told the space's pages from it, each made
// in its own chat or in another, so it never takes another chat's page for its own (the runtime agent reads it,
// `jobs/space_pages.rs`, and writes down a page a wake starts again that it does not hold yet).
//
// It is kept with the space's files, under `.instafy/` (never saved, published, listed or copied into a scoped
// worker's copy), not with the CLI's own state in the home folder: a stopped space's next machine starts with a new
// home folder, and the record has to be there for the next turn.
export const PAGES_RECORD_DIR = path.join(".instafy", "pages");
export const PAGES_RECORD_FILE = path.join(PAGES_RECORD_DIR, "pages.json");
// The record's folder holds nothing a save, a status or a person's own git should see.
const PAGES_RECORD_IGNORE = "*\n";
const MAX_RECORDED = 100;

export type RecordedPage = {
  folder: string;
  title: string;
  // The chat that made the page. Absent for a page from before the record (one a wake wrote down): no later open claims
  // it, and every chat reads it as another chat's.
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

/**
 * Writes down the page in `folder` (relative to the space's workspace `root`) whose card this open posted to
 * `opening`: with the chat the record already keeps for that folder, else `opening`. A folder that is gone from the
 * workspace leaves the record. The workspace itself is the person's own site, no page a chat made, and is not written
 * down.
 */
export function recordPage(
  root: string,
  page: { folder: string; title: string; argv: string[]; opening: string | undefined },
  now: Date = new Date(),
): RecordedPage | null {
  const folder = page.folder.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!folder || folder === "." || folder.startsWith("../") || path.isAbsolute(folder)) return null;
  const file = path.join(root, PAGES_RECORD_FILE);
  const pages = readPages(file);
  const earlier = pages.find((entry) => entry.folder === folder);
  const madeIn = earlier ? earlier.conversationId : page.opening;
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
