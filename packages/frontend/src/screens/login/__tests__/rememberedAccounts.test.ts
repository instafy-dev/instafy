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
