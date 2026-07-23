import { describe, expect, it, vi } from "vitest";
import {
  isInvalidRefreshTokenError,
  signInWithPasswordRecoveringInvalidRefreshToken,
} from "./authSessionRecovery";

describe("authSessionRecovery", () => {
  it("retries once after clearing stale auth state for invalid refresh token errors", async () => {
    const clearAuthStorage = vi.fn();
    const signInWithPassword = vi
      .fn()
      .mockResolvedValueOnce({
        error: new Error("Invalid Refresh Token: refresh token not found"),
      })
      .mockResolvedValueOnce({ data: { session: { access_token: "next-token" } } });
    const signOut = vi.fn().mockResolvedValue(undefined);

    const result = await signInWithPasswordRecoveringInvalidRefreshToken(
      {
        signInWithPassword,
        signOut,
      },
      {
        email: "playwright@instafy.dev",
        password: "Playwright123!",
      },
      { clearAuthStorage },
    );

    expect(signInWithPassword).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearAuthStorage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: { session: { access_token: "next-token" } } });
  });

  it("does not clear storage for non-refresh-token errors", async () => {
    const clearAuthStorage = vi.fn();
    const signInWithPassword = vi.fn().mockResolvedValue({
      error: new Error("Invalid login credentials"),
    });
    const signOut = vi.fn().mockResolvedValue(undefined);

    await expect(
      signInWithPasswordRecoveringInvalidRefreshToken(
        {
          signInWithPassword,
          signOut,
        },
        {
          email: "playwright@instafy.dev",
          password: "Playwright123!",
        },
        { clearAuthStorage },
      ),
    ).rejects.toThrow("Invalid login credentials");

    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
    expect(clearAuthStorage).not.toHaveBeenCalled();
  });

  it("recognizes refresh-token errors from either common message form", () => {
    expect(isInvalidRefreshTokenError(new Error("Invalid Refresh Token"))).toBe(true);
    expect(isInvalidRefreshTokenError(new Error("Refresh token not found"))).toBe(true);
    expect(isInvalidRefreshTokenError(new Error("Network request failed"))).toBe(false);
  });
});
