import { describe, expect, it } from "vitest";
import type { CodeFile } from "../../../../types";
import {
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

    it("raises the stale notice for a dirty buffer without its read ids", () => {
      expect(stateless({ blobOid: BLOB_A, modified: "edit" }, BLOB_A)).toBe("stale");
      expect(desktop({ baseRev: REV, modified: "edit" }, BLOB_A)).toBe("stale");
    });

    it("never copies the listing rev and always reuses a new buffer", () => {
      expect(stateless({ isNew: true, generated: "", modified: "draft" }, null)).toBe("reuse");
      expect(desktop({ isNew: true, generated: "", modified: "" }, BLOB_A)).toBe("reuse");
    });

    it("keeps a dirty buffer when the listing has no blob to compare", () => {
      expect(stateless({ blobOid: BLOB_A, baseRev: REV, modified: "edit" }, null)).toBe("reuse");
      expect(stateless({ blobOid: BLOB_A, baseRev: REV }, null)).toBe("refetch");
    });
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
});
