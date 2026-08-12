import { describe, expect, test, vi } from "vitest";
import {
  deriveRememberedAccountProviderFromUser,
  parseRememberedAccounts,
  upsertRememberedAccount,
} from "../rememberedAccounts";

describe("rememberedAccounts", () => {
  test("parses GitHub provider from storage", () => {
    const accounts = parseRememberedAccounts(
      JSON.stringify([
        {
          email: "octo@example.com",
          displayName: "Octo",
          lastUsedAt: 10,
          provider: "github",
        },
      ]),
    );

    expect(accounts).toEqual([
      {
        email: "octo@example.com",
        displayName: "Octo",
        lastUsedAt: 10,
        provider: "github",
      },
    ]);
  });

  test("defaults older remembered accounts to email provider", () => {
    const accounts = parseRememberedAccounts(
      JSON.stringify([
        {
          email: "octo@example.com",
          displayName: "Octo",
          lastUsedAt: 10,
        },
      ]),
    );

    expect(accounts[0]?.provider).toBe("email");
  });

  test("upsert stores provider metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const accounts = upsertRememberedAccount([], "octo@example.com", {
      displayName: "Octo",
      provider: "github",
    });

    expect(accounts).toEqual([
      {
        email: "octo@example.com",
        displayName: "Octo",
        lastUsedAt: Date.parse("2026-03-14T12:00:00Z"),
        provider: "github",
      },
    ]);

    vi.useRealTimers();
  });

  test("derives GitHub provider from Supabase user metadata", () => {
    const provider = deriveRememberedAccountProviderFromUser({
      app_metadata: { provider: "github", providers: ["github"] },
      identities: [],
    } as never);

    expect(provider).toBe("github");
  });

  test("falls back to identity providers when app metadata is missing", () => {
    const provider = deriveRememberedAccountProviderFromUser({
      app_metadata: {},
      identities: [{ provider: "github" }],
    } as never);

    expect(provider).toBe("github");
  });
});

describe("google provider", () => {
  test("parses Google provider from storage", () => {
    const accounts = parseRememberedAccounts(
      JSON.stringify([
        {
          email: "octo@example.com",
          displayName: "Octo",
          lastUsedAt: 10,
          provider: "google",
        },
      ]),
    );

    expect(accounts[0]?.provider).toBe("google");
  });

  test("derives google from the current session's app_metadata", () => {
    expect(
      deriveRememberedAccountProviderFromUser({
        app_metadata: { provider: "google", providers: ["google"] },
        identities: [],
      }),
    ).toBe("google");
  });

  test("the session's own provider wins for a user with linked identities", () => {
    // A user who linked both GitHub and Google must be remembered under the
    // door they walked through THIS time -- app_metadata.provider is the
    // current session's identity and outranks the identities list.
    expect(
      deriveRememberedAccountProviderFromUser({
        app_metadata: { provider: "google", providers: ["github", "google"] },
        identities: [
          { provider: "github" } as never,
          { provider: "google" } as never,
        ],
      }),
    ).toBe("google");
    expect(
      deriveRememberedAccountProviderFromUser({
        app_metadata: { provider: "github", providers: ["github", "google"] },
        identities: [
          { provider: "github" } as never,
          { provider: "google" } as never,
        ],
      }),
    ).toBe("github");
  });

  test("unknown providers still normalize to email", () => {
    expect(
      deriveRememberedAccountProviderFromUser({
        app_metadata: { provider: "azure", providers: ["azure"] },
        identities: [{ provider: "azure" } as never],
      }),
    ).toBe("email");
  });
});
