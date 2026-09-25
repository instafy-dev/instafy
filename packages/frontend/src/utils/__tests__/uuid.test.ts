import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUUID, isUUID } from "../uuid";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generateUUID", () => {
  it("uses the native UUID API when available", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    vi.stubGlobal("crypto", { randomUUID: () => id });
    expect(generateUUID()).toBe(id);
  });

  it.each([0, 255])("uses secure bytes without randomUUID (byte value %i)", fill => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(fill));
    vi.stubGlobal("crypto", { getRandomValues });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Insecure randomness must not be used");
    });

    const id = generateUUID();

    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(isUUID(id)).toBe(true);
    expect(id).toBe(fill === 0
      ? "00000000-0000-4000-8000-000000000000"
      : "ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it.each([undefined, {}])("rejects environments without secure randomness (%j)", cryptoValue => {
    vi.stubGlobal("crypto", cryptoValue);
    expect(() => generateUUID()).toThrow("Secure randomness is required");
  });
});
