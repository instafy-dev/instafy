import { expect, test } from "@playwright/test";

test.describe("remembered login accounts", () => {
  test("provider-specific remembered accounts keep the right login flow", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "instafy.rememberedAccounts",
        JSON.stringify([
          {
            email: "github-user@example.com",
            displayName: "GitHub User",
            lastUsedAt: Date.now(),
            provider: "github",
          },
          {
            email: "password-user@example.com",
            displayName: "Password User",
            lastUsedAt: Date.now() - 1000,
            provider: "email",
          },
        ]),
      );
    });

    await page.goto("/login", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: /log back in/i })).toBeVisible();
    await expect(page.getByText("Continue with GitHub")).toBeVisible();

    await page.getByRole("button", { name: /continue with password as password-user@example.com/i }).click();
    await expect(page.getByRole("heading", { name: /enter your password/i })).toBeVisible();

    await page.goto("/login", { waitUntil: "domcontentloaded" });

    let authorizeUrl: string | null = null;
    await page.route("**/auth/v1/authorize**", async (route) => {
      authorizeUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>oauth intercepted</body></html>",
      });
    });

    await page.getByRole("button", { name: /continue with github as github-user@example.com/i }).click();
    await page.waitForLoadState("domcontentloaded");

    expect(authorizeUrl).toContain("provider=github");
    await expect(page).toHaveURL(/\/auth\/v1\/authorize\?provider=github/);
    await expect(page.getByText("oauth intercepted")).toBeVisible();
  });
});
