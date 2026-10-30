import { describe, expect, it } from "vitest";
import { withoutSessionUrlParameters } from "../sessionUrlParameters";

const BASE = "https://prod.instafy.dev";

describe("withoutSessionUrlParameters", () => {
  it("leaves an address without session parameters alone", () => {
    for (const path of [
      "/studio",
      "/studio?projectId=p1&panel=settings",
      "/studio?projectId=p1#section",
      "/login?type=recovery",
      "/login?mode=recovery&redirect=%2Fstudio",
      "/invite?token=invite-token",
      "/cli/login?cliState=s&cliCallbackUrl=http%3A%2F%2F127.0.0.1%3A4000%2Fcallback",
    ]) {
      expect(withoutSessionUrlParameters(`${BASE}${path}`)).toBeNull();
    }
  });

  it("removes session parameters from the query and keeps the others", () => {
    expect(withoutSessionUrlParameters(`${BASE}/login?error_description=x&redirect=%2Fstudio`)).toBe(
      `${BASE}/login?redirect=%2Fstudio`,
    );
    expect(withoutSessionUrlParameters(`${BASE}/studio?projectId=p1&code=attacker-code`)).toBe(
      `${BASE}/studio?projectId=p1`,
    );
    expect(withoutSessionUrlParameters(`${BASE}/login?access_token=a&refresh_token=b`)).toBe(`${BASE}/login`);
  });

  it("re-encodes the remaining query once it removes something", () => {
    expect(withoutSessionUrlParameters(`${BASE}/login?redirect=/studio&q=a%20b&code=x`)).toBe(
      `${BASE}/login?redirect=%2Fstudio&q=a+b`,
    );
  });

  it("matches keys more broadly than auth-js: decoded, trimmed and in any case", () => {
    for (const query of ["%61ccess_token=a", "ERROR_DESCRIPTION=x", "%20code%20=x", "Error=access_denied"]) {
      expect(withoutSessionUrlParameters(`${BASE}/login?${query}`)).toBe(`${BASE}/login`);
    }
  });

  it("drops a fragment that carries any session parameter", () => {
    expect(withoutSessionUrlParameters(`${BASE}/studio?projectId=p1#error_description=x`)).toBe(
      `${BASE}/studio?projectId=p1`,
    );
    expect(
      withoutSessionUrlParameters(`${BASE}/login#access_token=a&refresh_token=b&expires_in=3600&token_type=bearer`),
    ).toBe(`${BASE}/login`);
    // auth-js reads the whole fragment as parameters, so a hash-router shape
    // still counts.
    expect(withoutSessionUrlParameters(`${BASE}/studio#/route?a=1&error_description=x`)).toBe(`${BASE}/studio`);
  });

  it("returns null for something that is not an address", () => {
    expect(withoutSessionUrlParameters("not a url")).toBeNull();
  });
});
