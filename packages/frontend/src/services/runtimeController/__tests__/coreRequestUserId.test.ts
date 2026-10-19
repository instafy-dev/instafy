// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/supabaseClient", () => ({ supabase: { auth: {} } }));

import { controllerRequestContextUserId } from "../core";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const USER_ID = "624AE065-1CFE-4A2B-9C3D-0123456789AB";
const OTHER_ID = "7f3e2d1c-0b9a-4876-a543-210fedcba987";

describe("controllerRequestContextUserId", () => {
  it("reads the user the controller reads from the token", () => {
    expect(controllerRequestContextUserId({ accessToken: jwt({ sub: USER_ID }) })).toBe(USER_ID.toLowerCase());
    // Supabase tokens: the controller prefers user_id over sub.
    expect(controllerRequestContextUserId({ accessToken: jwt({ user_id: OTHER_ID, sub: USER_ID }) })).toBe(OTHER_ID);
    expect(controllerRequestContextUserId({ accessToken: jwt({ user_id: null, sub: USER_ID }) })).toBe(USER_ID.toLowerCase());
  });

  it.each([
    ["no token", null],
    ["an opaque token", "opaque-token"],
    ["a scoped runtime token", jwt({ sub: "proxy:project:runtime" })],
    ["a token without a subject", jwt({ exp: 1 })],
    ["a malformed user_id", jwt({ user_id: "not-a-user", sub: USER_ID })],
  ])("names no user for %s", (_label, accessToken) => {
    expect(controllerRequestContextUserId({ accessToken })).toBeNull();
  });
});
