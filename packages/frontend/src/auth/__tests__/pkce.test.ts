import { describe, expect, it, vi } from "vitest";
import {
  describeExchangeError,
  hasImplicitAuthHash,
  loginEmailRedirectTo,
  requestEmailOtp,
  requestEmailSignup,
  requestPasswordRecovery,
  resolveSupabaseFlowType,
} from "../pkce";

describe("flow type shim", () => {
  it("keeps PKCE for ordinary loads", () => {
    expect(resolveSupabaseFlowType(null)).toBe("pkce");
    expect(resolveSupabaseFlowType("")).toBe("pkce");
    expect(resolveSupabaseFlowType("#")).toBe("pkce");
    expect(resolveSupabaseFlowType("#type=recovery")).toBe("pkce");
    expect(resolveSupabaseFlowType("?code=abc")).toBe("pkce");
  });

  it("falls back to implicit ONLY for legacy hash-token callbacks", () => {
    // The stake: auth-js configured for PKCE meets a hash-token URL, throws,
    // and WIPES the stored session with the error swallowed. In-flight
    // sign-ins and recovery emails in inboxes are shaped like this
    // mid-rollout.
    expect(
      resolveSupabaseFlowType("#access_token=a&refresh_token=b&token_type=bearer"),
    ).toBe("implicit");
    expect(hasImplicitAuthHash("access_token=a&type=recovery")).toBe(true);
    // A code param in the hash is not an implicit callback.
    expect(hasImplicitAuthHash("#code=abc")).toBe(false);
  });
});

describe("exchange error mapping", () => {
  it("translates the missing-verifier failure into an actionable message", () => {
    expect(
      describeExchangeError(
        "invalid request: both auth code and code verifier should be non-empty",
      ),
    ).toMatch(/on this device/i);
    expect(describeExchangeError("flow state not found")).toMatch(/on this device/i);
  });

  it("translates expiry and passes everything else through", () => {
    expect(describeExchangeError("Email link is invalid or has expired")).toMatch(/expired/i);
    expect(describeExchangeError("network unreachable")).toBe("network unreachable");
  });
});

describe("password recovery request", () => {
  it("posts to /recover WITHOUT a code challenge and carries redirect_to", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    await requestPasswordRecovery({
      supabaseUrl: "https://proj.supabase.co",
      anonKey: "anon",
      email: "user@example.com",
      redirectTo: "https://instafy.dev/login?mode=recovery",
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://proj.supabase.co/auth/v1/recover");
    expect(url).toContain("redirect_to=");
    const body = JSON.parse(String(init.body));
    // The whole point: no code_challenge, so the emailed link stays
    // token-shaped and works cross-device.
    expect(body).toEqual({ email: "user@example.com" });
    expect((init.headers as Record<string, string>).apikey).toBe("anon");
  });

  it("surfaces GoTrue error text on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ msg: "For security purposes, you can only request this once every 60 seconds" }),
    } as unknown as Response);
    await expect(
      requestPasswordRecovery({
        supabaseUrl: "https://proj.supabase.co",
        anonKey: "anon",
        email: "user@example.com",
        fetchImpl,
      }),
    ).rejects.toThrow(/60 seconds/);
  });
});

describe("login email redirect threading", () => {
  it("carries the pending ?redirect= back through the emailed link", () => {
    expect(
      loginEmailRedirectTo({ origin: "https://instafy.dev", search: "?redirect=%2Finvite%3Ftoken%3Dabc" }),
    ).toBe("https://instafy.dev/login?redirect=%2Finvite%3Ftoken%3Dabc");
  });

  it("defaults to /login and refuses absolute or protocol-relative targets", () => {
    expect(loginEmailRedirectTo({ origin: "https://instafy.dev", search: "" }))
      .toBe("https://instafy.dev/login");
    // open-redirect guard: only same-origin paths ride along
    expect(
      loginEmailRedirectTo({ origin: "https://instafy.dev", search: "?redirect=https%3A%2F%2Fevil.example" }),
    ).toBe("https://instafy.dev/login");
    expect(
      loginEmailRedirectTo({ origin: "https://instafy.dev", search: "?redirect=%2F%2Fevil.example" }),
    ).toBe("https://instafy.dev/login");
  });
});

describe("challenge-free signup and OTP", () => {
  it("signs up without a code challenge and threads the redirect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    await requestEmailSignup({
      supabaseUrl: "https://proj.supabase.co", anonKey: "anon",
      email: "user@example.com", password: "pw",
      redirectTo: "https://instafy.dev/login?redirect=%2Finvite%3Ftoken%3Dabc",
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/auth/v1/signup");
    expect(url).toContain("redirect_to=");
    // The point: no code_challenge, so the confirmation link stays
    // token-shaped and works on any device.
    expect(JSON.parse(String(init.body))).toEqual({ email: "user@example.com", password: "pw" });
  });

  it("requests OTP with create_user and no challenge", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    await requestEmailOtp({
      supabaseUrl: "https://proj.supabase.co", anonKey: "anon",
      email: "user@example.com", shouldCreateUser: true, fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/auth/v1/otp");
    expect(JSON.parse(String(init.body))).toEqual({ email: "user@example.com", create_user: true });
  });
});
