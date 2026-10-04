import { describe, expect, it } from "vitest";
import type { CodeFile } from "../../../../types";
import {
  advanceListingRevisions,
  bufferSaveOriginId,
  bufferVersioningMode,
  createOwnRevisions,
  decideCachedOpen,
  isFileBufferDirty,
  isVersionedFilesMode,
  mergeNewFileBuffers,
  OWN_REVISION_WINDOW_MS,
} from "../filesVersioning";

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const REV = "1".repeat(40);

function buffer(patch: Partial<CodeFile> = {}): CodeFile {
  return {
    id: "README.md",
    path: "README.md",
    label: "README.md",
    generated: "saved",
    modified: "saved",
    ...patch,
  };
}

describe("Files versioning helpers", () => {
  it("uses the one Save only in the stateless and desktop modes", () => {
    expect(isVersionedFilesMode({ mode: "stateless", originId: "o" })).toBe(true);
    expect(isVersionedFilesMode({ mode: "desktop", originId: "o" })).toBe(true);
    expect(isVersionedFilesMode({ mode: "legacy", originId: "o" })).toBe(false);
    expect(isVersionedFilesMode(null)).toBe(false);
  });

  it("counts a never-saved buffer as dirty even when it is empty", () => {
    expect(isFileBufferDirty(buffer())).toBe(false);
    expect(isFileBufferDirty(buffer({ modified: "edited" }))).toBe(true);
    expect(isFileBufferDirty(buffer({ generated: "", modified: "", isNew: true }))).toBe(true);
  });

  describe("reopening a cached buffer (plan 2.3 table)", () => {
    const stateless = (cached: Partial<CodeFile>, listingBlobOid: string | null) =>
      decideCachedOpen({ cached: buffer(cached), listingBlobOid, mode: "stateless" });
    const desktop = (cached: Partial<CodeFile>, listingBlobOid: string | null) =>
      decideCachedOpen({ cached: buffer(cached), listingBlobOid, mode: "desktop" });

    it("reuses a clean buffer whose blob matches the listing", () => {
      expect(stateless({ blobOid: BLOB_A, baseRev: REV }, BLOB_A)).toBe("reuse");
      expect(desktop({ blobOid: BLOB_A }, BLOB_A)).toBe("reuse");
    });

    it("refetches a clean buffer whose blob differs or that lacks its read ids", () => {
      expect(stateless({ blobOid: BLOB_A, baseRev: REV }, BLOB_B)).toBe("refetch");
      expect(stateless({ blobOid: BLOB_A }, BLOB_A)).toBe("refetch");
      expect(stateless({ baseRev: REV }, BLOB_A)).toBe("refetch");
      expect(desktop({}, BLOB_A)).toBe("refetch");
    });

    it("keeps a dirty buffer whose blob matches the listing", () => {
      expect(stateless({ blobOid: BLOB_A, baseRev: REV, modified: "edit" }, BLOB_A)).toBe("reuse");
      expect(desktop({ blobOid: BLOB_A, modified: "edit" }, BLOB_A)).toBe("reuse");
    });

    it("raises the stale notice for a dirty buffer whose blob differs", () => {
      expect(stateless({ blobOid: BLOB_A, baseRev: REV, modified: "edit" }, BLOB_B)).toBe("stale");
      expect(desktop({ blobOid: BLOB_A, modified: "edit" }, BLOB_B)).toBe("stale");
    });

    it("reads a dirty buffer without its read ids once to check its base text", () => {
      expect(stateless({ blobOid: BLOB_A, modified: "edit" }, BLOB_A)).toBe("verify");
      expect(desktop({ baseRev: REV, modified: "edit" }, BLOB_A)).toBe("verify");
    });

    it("never copies the listing rev and always reuses a new buffer", () => {
      expect(stateless({ isNew: true, generated: "", modified: "draft" }, null)).toBe("reuse");
      expect(desktop({ isNew: true, generated: "", modified: "" }, BLOB_A)).toBe("reuse");
    });

    it("does not trust read ids from another origin than the one read now", () => {
      const fromGateway = { blobOid: BLOB_A, baseRev: REV, originId: "gateway-1" };
      const open = (cached: Partial<CodeFile>) =>
        decideCachedOpen({ cached: buffer(cached), listingBlobOid: BLOB_A, mode: "desktop", originId: "desktop-1" });
      expect(open(fromGateway)).toBe("refetch");
      expect(open({ ...fromGateway, modified: "edit" })).toBe("verify");
      expect(open({ ...fromGateway, originId: "desktop-1" })).toBe("reuse");
    });

    it("keeps a dirty buffer when the listing has no blob to compare", () => {
      expect(stateless({ blobOid: BLOB_A, baseRev: REV, modified: "edit" }, null)).toBe("reuse");
      expect(stateless({ blobOid: BLOB_A, baseRev: REV }, null)).toBe("refetch");
    });
  });

  it("saves a buffer to its own origin and checks it the way that origin does", () => {
    const desktopMode = { mode: "desktop" as const, originId: "desktop-1" };
    const statelessMode = { mode: "stateless" as const, originId: "gateway-1" };
    const fromGateway = buffer({ originId: "gateway-1", baseRev: REV, blobOid: BLOB_A });
    const fromDesktop = buffer({ originId: "desktop-1", blobOid: BLOB_A });
    expect(bufferSaveOriginId(fromGateway, desktopMode)).toBe("gateway-1");
    expect(bufferVersioningMode(fromGateway, desktopMode)).toBe("stateless");
    expect(bufferSaveOriginId(fromDesktop, statelessMode)).toBe("desktop-1");
    expect(bufferVersioningMode(fromDesktop, statelessMode)).toBe("desktop");
    expect(bufferVersioningMode(fromGateway, statelessMode)).toBe("stateless");
    expect(bufferVersioningMode(buffer(), desktopMode)).toBe("desktop");
    // A new file that was never written anywhere goes where the space is saved now.
    const created = buffer({ originId: "gateway-1", isNew: true, generated: "", modified: "" });
    expect(bufferSaveOriginId(created, desktopMode)).toBe("desktop-1");
    expect(bufferVersioningMode(created, desktopMode)).toBe("desktop");
  });

  it("remembers own revisions for 60 seconds", () => {
    let now = 1_000;
    const own = createOwnRevisions(() => now);
    own.add(` ${REV} `);
    own.add(null);
    expect(own.has(REV)).toBe(true);
    expect(own.has("other")).toBe(false);
    now += OWN_REVISION_WINDOW_MS + 1;
    expect(own.has(REV)).toBe(false);
  });

  it("remembers blobs this tab is saving per path for 60 seconds", () => {
    let now = 1_000;
    const own = createOwnRevisions(() => now);
    own.addWrite("README.md", BLOB_A);
    own.addWrite("README.md", null);
    expect(own.hasWrite("README.md", BLOB_A)).toBe(true);
    expect(own.hasWrite("README.md", BLOB_B)).toBe(false);
    expect(own.hasWrite("other.md", BLOB_A)).toBe(false);
    expect(own.hasWrite("README.md", null)).toBe(false);
    now += OWN_REVISION_WINDOW_MS + 1;
    expect(own.hasWrite("README.md", BLOB_A)).toBe(false);
  });

  it("moves only the listings at the commit an own save built on to that save's commit", () => {
    const REV_2 = "2".repeat(40);
    const REV_3 = "3".repeat(40);
    const revs = { "": REV, docs: REV, src: REV_2, empty: null };
    expect(advanceListingRevisions(revs, REV, REV_3)).toEqual({ "": REV_3, docs: REV_3, src: REV_2, empty: null });
    expect(revs[""]).toBe(REV);
    expect(advanceListingRevisions(revs, REV_3, REV_2)).toBe(revs);
    expect(advanceListingRevisions(revs, null, REV_3)).toBe(revs);
    expect(advanceListingRevisions(revs, REV, REV)).toBe(revs);
  });

  it("adds never-saved buffers to their listed folder only", () => {
    const sort = (entries: { name: string }[]) => [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const listing = { src: [{ name: "b.ts", path: "src/b.ts", kind: "file" as const }] };
    const files = [
      buffer({ id: "src/a.ts", path: "src/a.ts", label: "a.ts", isNew: true, generated: "", modified: "" }),
      buffer({ id: "lib/c.ts", path: "lib/c.ts", label: "c.ts", isNew: true }),
      buffer({ id: "src/b.ts", path: "src/b.ts", label: "b.ts", isNew: true }),
      buffer({ id: "src/d.ts", path: "src/d.ts", label: "d.ts" }),
    ];
    const merged = mergeNewFileBuffers(listing, files, sort as never);
    expect(merged.src.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(merged.lib).toBeUndefined();
    expect(mergeNewFileBuffers(listing, [], sort as never)).toBe(listing);
  });

  it("keeps the folders of a new file that are not in the space yet", () => {
    const sort = (entries: { name: string }[]) => [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const listing = {
      "": [{ name: "README.md", path: "README.md", kind: "file" as const }, { name: "src", path: "src", kind: "directory" as const }],
    };
    const created = (path: string) =>
      buffer({ id: path, path, label: path.split("/").pop()!, isNew: true, generated: "", modified: "" });
    const merged = mergeNewFileBuffers(listing, [created("notes/deep/todo.md")], sort as never);
    expect(merged[""].map((entry) => [entry.path, entry.kind])).toEqual([
      ["notes", "directory"], ["README.md", "file"], ["src", "directory"],
    ]);
    expect(merged.notes.map((entry) => entry.path)).toEqual(["notes/deep"]);
    expect(merged["notes/deep"].map((entry) => entry.path)).toEqual(["notes/deep/todo.md"]);
    expect(listing[""]).toHaveLength(2);
    // A folder that is in the space but was never listed is listed when opened.
    expect(mergeNewFileBuffers(listing, [created("src/new.ts")], sort as never).src).toBeUndefined();
  });
});
