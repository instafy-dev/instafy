import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() }));
vi.mock("../supabaseClient", () => ({ supabase: { storage: { from: () => storage } } }));
import { uploadIdentityImage, validateIdentityImage } from "../identityImages";

describe("identity image upload", () => {
  beforeEach(() => { storage.upload.mockReset().mockResolvedValue({ error: null }); storage.getPublicUrl.mockReturnValue({ data: { publicUrl: "https://storage.example/picture.webp" } }); });
  it.each(["orgs", "spaces", "agents"] as const)("uses an immutable scoped %s path and safe extension", async kind => {
    const file = new File(["picture"], "../../private.svg", { type: "image/webp" });
    await uploadIdentityImage(kind, "11111111-1111-4111-8111-111111111111", file);
    expect(storage.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${kind}/11111111-1111-4111-8111-111111111111/[0-9a-f-]{36}\\.webp$`)), file,
      { cacheControl: "31536000", upsert: false, contentType: "image/webp" });
  });
  it("rejects unsupported, oversized or empty files before upload", async () => {
    for (const file of [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }), new File([new Uint8Array(2097153)], "x.png", { type: "image/png" }), new File([], "x.png", { type: "image/png" })]) {
      expect(validateIdentityImage(file)).toBeTruthy();
      await expect(uploadIdentityImage("spaces", "bad", file)).rejects.toThrow();
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("does not produce a URL when storage rejects the user", async () => {
    storage.upload.mockResolvedValue({ error: { message: "Not authorized" } });
    await expect(uploadIdentityImage("spaces", "11111111-1111-4111-8111-111111111111", new File(["x"], "x.png", { type: "image/png" }))).rejects.toThrow("Not authorized");
  });
});
