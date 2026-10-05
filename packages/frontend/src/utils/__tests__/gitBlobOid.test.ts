import { afterEach, describe, expect, it, vi } from "vitest";
import { gitBlobOid } from "../gitBlobOid";

afterEach(() => vi.unstubAllGlobals());

describe("gitBlobOid", () => {
  it("matches git hash-object for text", async () => {
    expect(await gitBlobOid("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("matches git hash-object for an empty file", async () => {
    expect(await gitBlobOid("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobOid(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("hashes bytes and multi-byte text by byte length", async () => {
    const text = "héllo\n";
    // git hash-object of the UTF-8 bytes
    expect(await gitBlobOid(text)).toBe("5fb50d3c93474f139362304b663fe44e9d17a26e");
    expect(await gitBlobOid(new TextEncoder().encode(text))).toBe("5fb50d3c93474f139362304b663fe44e9d17a26e");
  });

  it("resolves to null without WebCrypto", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(await gitBlobOid("hello\n")).toBeNull();
  });
});
