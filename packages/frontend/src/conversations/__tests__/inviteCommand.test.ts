import { describe, expect, it } from "vitest";
import { isLikelyInviteEmail, parseInviteCommandRequest } from "../inviteCommand";

describe("parseInviteCommandRequest", () => {
  it("parses /invite with the default builder role", () => {
    expect(parseInviteCommandRequest("/invite teammate@instafy.dev")).toEqual({
      email: "teammate@instafy.dev",
      role: "builder",
      error: null,
    });
  });

  it("parses /invite with an explicit role", () => {
    expect(parseInviteCommandRequest("/invite teammate@instafy.dev viewer")).toEqual({
      email: "teammate@instafy.dev",
      role: "viewer",
      error: null,
    });
  });

  it("returns a syntax error for extra arguments", () => {
    expect(parseInviteCommandRequest("/invite teammate@instafy.dev viewer now")).toEqual({
      email: "teammate@instafy.dev",
      role: "builder",
      error: "Use /invite email@example.com or /invite email@example.com builder.",
    });
  });

  it("returns a syntax error for invalid roles", () => {
    expect(parseInviteCommandRequest("/invite teammate@instafy.dev editor")).toEqual({
      email: "teammate@instafy.dev",
      role: "builder",
      error: "Role must be viewer or builder.",
    });
  });

  it("does not allow organization-level roles in a space invite", () => {
    expect(parseInviteCommandRequest("/invite teammate@instafy.dev admin")).toEqual({
      email: "teammate@instafy.dev",
      role: "builder",
      error: "Role must be viewer or builder.",
    });
  });

  it("returns null for non-invite text", () => {
    expect(parseInviteCommandRequest("hello there")).toBeNull();
  });
});

describe("isLikelyInviteEmail", () => {
  it("accepts basic email addresses", () => {
    expect(isLikelyInviteEmail("teammate@instafy.dev")).toBe(true);
  });

  it("rejects malformed email addresses", () => {
    expect(isLikelyInviteEmail("not-an-email")).toBe(false);
  });
});
