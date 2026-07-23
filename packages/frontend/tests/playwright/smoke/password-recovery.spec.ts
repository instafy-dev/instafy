import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getSupabaseAuthHeaders, getSupabaseUrl } from "../utils/harness.js";

type MailpitMessageList = {
  messages: Array<{
    ID: string;
    Subject?: string;
    To?: Array<{ Address?: string }>;
  }>;
};

type MailpitMessage = {
  ID: string;
  Text?: string;
  HTML?: string;
};

const MAILPIT_BASE_URL = process.env.PLAYWRIGHT_MAILPIT_URL?.trim() || "http://127.0.0.1:54324";

async function waitForMailpitMessageId(
  request: import("@playwright/test").APIRequestContext,
  targetEmail: string,
  timeoutMs = 20_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request
      .get(`${MAILPIT_BASE_URL}/api/v1/messages?limit=50`)
      .catch(() => null);
    if (response && response.ok()) {
      const payload = (await response.json()) as MailpitMessageList;
      const message = payload.messages.find((candidate) =>
        (candidate.To ?? []).some((entry) => entry?.Address?.toLowerCase() === targetEmail.toLowerCase())
      );
      if (message?.ID) {
        return message.ID;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Mailpit message to ${targetEmail}`);
}

function extractRecoveryLink(raw: string): string | null {
  const match = raw.match(/https?:\/\/[^\s]+\/auth\/v1\/verify\?[^\s]+/i);
  if (!match) {
    return null;
  }
  return match[0].replace(/[)>.,]+$/g, "");
}

test("password recovery link routes to reset flow", async ({ page, request }) => {
  const supabaseUrl = getSupabaseUrl();
  const headers = getSupabaseAuthHeaders();
  if (!supabaseUrl || !supabaseUrl.includes("127.0.0.1")) {
    test.skip(true, "Requires local Supabase (Mailpit) stack.");
  }
  if (!headers.authorization) {
    test.skip(true, "Missing SUPABASE_SERVICE_ROLE_KEY for creating test users.");
  }

  const mailpitReady = await request
    .get(`${MAILPIT_BASE_URL}/api/v1/messages?limit=1`)
    .then((res) => res.ok())
    .catch(() => false);
  if (!mailpitReady) {
    test.skip(true, `Mailpit unavailable at ${MAILPIT_BASE_URL}`);
  }

  const email = `pw-recovery+${randomUUID()}@instafy.dev`;
  const initialPassword = "Playwright123!";

  const createUser = await request.post(`${supabaseUrl}/auth/v1/admin/users`, {
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    data: {
      email,
      password: initialPassword,
      email_confirm: true,
    },
  });
  if (!createUser.ok()) {
    const body = await createUser.text().catch(() => "");
    throw new Error(`Failed to create Supabase user (${createUser.status()}): ${body}`);
  }

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  await page.getByLabel(/email address/i).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /enter your password/i })).toBeVisible();

  const forgotPassword = page.getByRole("button", { name: /Forgot password\?/i });
  await expect(forgotPassword).toBeVisible();
  await forgotPassword.click();
  await expect(page.getByText(/Password reset email sent/i)).toBeVisible();

  const messageId = await waitForMailpitMessageId(request, email);
  const message = await request.get(`${MAILPIT_BASE_URL}/api/v1/message/${messageId}`);
  if (!message.ok()) {
    const body = await message.text().catch(() => "");
    throw new Error(`Failed to fetch Mailpit message (${message.status()}): ${body}`);
  }
  const messageBody = (await message.json()) as MailpitMessage;
  const recoveryLink =
    extractRecoveryLink(messageBody.Text ?? "") || extractRecoveryLink(messageBody.HTML ?? "");
  if (!recoveryLink) {
    throw new Error("Failed to extract recovery verify link from Mailpit message body.");
  }

  await page.goto(recoveryLink, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname.includes("/login"), { timeout: 30_000 });

  await expect(page.getByRole("heading", { name: /reset your password/i })).toBeVisible();
  await page.getByLabel(/new password/i).fill("Playwright456!");
  await page.getByLabel(/confirm password/i).fill("Playwright456!");
  await page.getByRole("button", { name: /update password/i }).click();

  await page.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 45_000 });
});
