import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

async function poisonSupabaseSessionStorage(page: Page) {
  await page.evaluate(() => {
    const authKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) {
        continue;
      }
      const normalized = key.toLowerCase();
      if (normalized.startsWith("sb-") && normalized.includes("auth-token")) {
        authKeys.push(key);
      }
    }

    const fallbackSession = {
      currentSession: {
        access_token: "invalid-access-token",
        refresh_token: "invalid-refresh-token",
        token_type: "bearer",
        expires_in: -3600,
        expires_at: 1,
        user: {
          id: "00000000-0000-4000-8000-000000000000",
          aud: "authenticated",
          role: "authenticated",
          email: "stale-session@instafy.dev",
          app_metadata: {
            provider: "email",
            providers: ["email"],
          },
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      },
      expiresAt: 1,
    };

    const mutate = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map((entry) => mutate(entry));
      }
      if (!value || typeof value !== "object") {
        return value;
      }
      const source = value as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(source)) {
        if (key === "refresh_token") {
          next[key] = "invalid-refresh-token";
          continue;
        }
        if (key === "access_token") {
          next[key] = "invalid-access-token";
          continue;
        }
        if (key === "expires_at" || key === "expiresAt") {
          next[key] = 1;
          continue;
        }
        if (key === "expires_in") {
          next[key] = -3600;
          continue;
        }
        next[key] = mutate(raw);
      }
      return next;
    };

    if (authKeys.length === 0) {
      window.localStorage.setItem("sb-local-auth-token", JSON.stringify(fallbackSession));
      return;
    }

    for (const key of authKeys) {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        window.localStorage.setItem(key, JSON.stringify(fallbackSession));
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        const next = mutate(parsed);
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        window.localStorage.setItem(key, JSON.stringify(fallbackSession));
      }
    }
  });
}

test.describe("Auth stale session recovery", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "auth-stale-session-recovery:cleanup" }).catch(() => {});
  });

  test("stale Supabase refresh tokens do not stall studio loading", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

    await poisonSupabaseSessionStorage(page);
    await page.goto("/studio", { waitUntil: "domcontentloaded" });

    await expect
      .poll(
        async () => {
          if (page.url().includes("/login")) {
            return "login";
          }
          const loadingVisible = await page
            .getByText("Loading Instafy…")
            .isVisible()
            .catch(() => false);
          return loadingVisible ? "loading" : "other";
        },
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe("login");

    const guestButton = page.getByRole("button", { name: /continue as guest/i });
    await expect(guestButton).toBeVisible({ timeout: 15_000 });
    await guestButton.click();

    await expect(page).toHaveURL(/\/studio/, { timeout: 45_000 });
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
  });
});
