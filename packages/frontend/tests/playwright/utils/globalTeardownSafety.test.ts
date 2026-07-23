import { describe, expect, it, vi } from "vitest";
import {
  runGenericTunnelGrantCleanup,
  shouldSkipGenericTunnelGrantCleanup,
} from "./globalTeardownSafety.js";

describe("generic tunnel-grant teardown safety", () => {
  it("does not invoke shared-log cleanup for an explicit external target", async () => {
    const cleanup = vi.fn(async () => undefined);

    const attempted = await runGenericTunnelGrantCleanup(
      {
        PLAYWRIGHT_EXTERNAL_BASE_URL: "https://prod.instafy.dev",
        VITE_SUPABASE_URL: "https://example.supabase.co",
      },
      cleanup,
    );

    expect(attempted).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("recognizes a production-style fallback URL even without the external flag", () => {
    expect(
      shouldSkipGenericTunnelGrantCleanup({
        PLAYWRIGHT_ELECTRON_SHARED_BROWSER_BASE_URL: "https://prod.instafy.dev",
      }),
    ).toBe(true);
    expect(
      shouldSkipGenericTunnelGrantCleanup({
        VITE_SUPABASE_URL: "https://example.supabase.co",
      }),
    ).toBe(true);
  });

  it("keeps the existing local cleanup path", async () => {
    const cleanup = vi.fn(async () => undefined);

    const attempted = await runGenericTunnelGrantCleanup(
      {
        PLAYWRIGHT_BASE_URL: "http://127.0.0.1:5173",
        VITE_SUPABASE_URL: "http://localhost:54321",
      },
      cleanup,
    );

    expect(attempted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
