import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pageFolder, pageFolderAge, recordPage, TURN_FOLDERS_FILE } from "../src/space-pages";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A workspace whose turn began with `folders` there, as the runtime writes them down; with `list` null, no list. */
function space(list: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-space-pages-"));
  roots.push(root);
  if (list !== null) {
    fs.mkdirSync(path.dirname(path.join(root, TURN_FOLDERS_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, TURN_FOLDERS_FILE), JSON.stringify(list));
  }
  return root;
}

const began = (folders: string[]) => ({ version: 1, job: "job-1", folders, complete: true });

describe("which chat a page is written down with", () => {
  // A page goes to the chat that opens its card only when that chat's turn made its folder. With the record gone (a
  // hosted space after a release), the first chat to open another chat's page used to become its maker.
  it("reads a folder as made in this turn only when it was not there as the turn began", () => {
    const root = space(began(["sites", "sites/porto", "trip"]));
    expect(pageFolderAge(root, "sites/porto")).toBe("existing");
    expect(pageFolderAge(root, "trip")).toBe("existing");
    expect(pageFolderAge(root, "sites/laptops")).toBe("new");
    expect(pageFolderAge(root, "maps")).toBe("new");
    expect(pageFolderAge(root, "maps/seville")).toBe("new");
    // deeper than the list goes: read by its first two names
    expect(pageFolderAge(root, "sites/porto/v2")).toBe("existing");
    expect(pageFolderAge(root, "sites/laptops/v2")).toBe("new");
    // the list leaves these out, so nothing says one is new
    expect(pageFolderAge(root, ".drafts/page")).toBe("existing");
    expect(pageFolderAge(root, "sites/.hidden")).toBe("existing");
    expect(pageFolderAge(root, "node_modules/page")).toBe("existing");
  });

  it("reads every folder as there before when no turn wrote the list down, or it is not whole", () => {
    for (const list of [null, "not a list", { version: 1, folders: [], complete: false }, { version: 1, folders: "sites", complete: true }, { version: 1, complete: true }]) {
      expect(pageFolderAge(space(list), "sites/laptops")).toBe("existing");
    }
  });

  it("writes the server's chat down, else the record's, else the opener's for a folder its turn made", () => {
    const root = space(began(["sites"]));
    for (const folder of ["sites/a", "sites/b", "sites/c", "sites/d"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
    const open = (folder: string, more: Partial<Parameters<typeof recordPage>[1]>) =>
      recordPage(root, { folder, title: "A page", argv: ["instafy", "bind", "serve", "."], opening: "opener", age: "existing", ...more });
    // nothing held, a folder that was there: no chat, and no later open claims it
    expect(open("sites/a", {})).not.toHaveProperty("conversationId");
    expect(open("sites/a", { age: "new", opening: "another" })).not.toHaveProperty("conversationId");
    // a folder this turn made: the opener's, and it stays so for another chat's open
    expect(open("sites/b", { age: "new" })).toMatchObject({ folder: "sites/b", conversationId: "opener" });
    expect(open("sites/b", { opening: "another" })).toMatchObject({ conversationId: "opener" });
    // the server's word wins over both
    expect(open("sites/b", { held: { conversationId: "maker" } })).toMatchObject({ conversationId: "maker" });
    expect(open("sites/c", { age: "new", held: { conversationId: null } })).not.toHaveProperty("conversationId");
    expect(open("sites/b", { held: { conversationId: null } })).not.toHaveProperty("conversationId");
    // no chat to give: none written
    expect(open("sites/d", { age: "new", opening: undefined })).not.toHaveProperty("conversationId");
    // the workspace itself and a folder outside it are no page
    expect(open(".", { age: "new" })).toBeNull();
    expect(open("../outside", { age: "new" })).toBeNull();
    expect(pageFolder("./sites/a/")).toBe("sites/a");
    expect(pageFolder("/sites/a")).toBeNull();
  });
});
