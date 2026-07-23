import { test, expect } from "@playwright/test";
import { getSupabaseUrl } from "../utils/harness.js";

function buildHeaders() {
  const headers: Record<string, string> = {};
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (anonKey) {
    headers.apikey = anonKey;
    headers.authorization = `Bearer ${anonKey}`;
  }
  return headers;
}

test.describe("Supabase health", () => {
  test("health endpoint responds", async ({ request }) => {
    const response = await request.get(`${getSupabaseUrl()}/auth/v1/health`, {
      headers: buildHeaders()
    });
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    expect(typeof payload).toBe("object");
    expect((payload?.name ?? payload?.version ?? "").toString().length).toBeGreaterThan(0);
  });
});
