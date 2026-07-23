#!/usr/bin/env node
/**
 * Auth email smoke: signup -> email -> activate, end to end against the LOCAL stack.
 *
 * Exercises the exact passwordless path the frontend uses (signInWithOtp ->
 * verifyOtp) against a local Supabase + Inbucket, and asserts:
 *   1. the OTP request is accepted,
 *   2. an email actually lands in Inbucket,
 *   3. it is OUR Instafy template (not the stock GoTrue one) and carries the code,
 *   4. the code activates the user (verify returns a real session).
 *
 * This is the CI guard that our custom auth email templates keep rendering and
 * that the signup->confirm flow stays wired. It talks raw GoTrue + Inbucket REST
 * (global fetch) so it needs no workspace deps.
 *
 * Preconditions: `pnpm supabase:up` (starts Postgres/auth/Inbucket + applies
 * migrations and the templates from supabase/supabase/config.toml). Env is read
 * from `supabase status` when not already primed.
 *
 * Usage: node scripts/auth-email-smoke.mjs
 */

import process from "node:process";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseAnonKey,
} from "./lib/localSupabaseEnv.mjs";

const OTP_LENGTH = 8; // must match supabase/supabase/config.toml [auth.email] otp_length
const INBUCKET_POLL_MS = 30_000;
const INBUCKET_POLL_INTERVAL_MS = 750;

function log(message) {
  console.log(`[auth-email-smoke] ${message}`);
}

function fail(message) {
  console.error(`[auth-email-smoke] FAIL: ${message}`);
  process.exit(1);
}

function trimSlash(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

function resolveConfig() {
  // Prefer already-primed env (CI), fall back to `supabase status`.
  let apiUrl = resolveLocalSupabaseApiUrl({ env: process.env });
  let anonKey = resolveLocalSupabaseAnonKey({ env: process.env });
  if (!apiUrl || !anonKey) {
    const statusEnv = readLocalSupabaseStatusEnv({ required: false });
    if (!statusEnv) {
      fail(
        "Local Supabase is not running. Start it first with `pnpm supabase:up`.",
      );
    }
    apiUrl = apiUrl || resolveLocalSupabaseApiUrl({ statusEnv });
    anonKey = anonKey || resolveLocalSupabaseAnonKey({ statusEnv });
  }
  if (!apiUrl || !anonKey) {
    fail("Could not resolve local Supabase API url / anon key.");
  }
  // Local mail catcher (Inbucket or Mailpit). Supabase serves it on 54324 by
  // default (config.toml [inbucket].port).
  const catcherUrl = trimSlash(
    process.env.SUPABASE_INBUCKET_URL ||
      process.env.INBUCKET_URL ||
      "http://127.0.0.1:54324",
  );
  return { apiUrl: trimSlash(apiUrl), anonKey, catcherUrl };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAuthReady({ apiUrl, anonKey }) {
  // The stack-up fallback can return before GoTrue finishes initializing
  // (supabase-stack.mjs retries `start --ignore-health-check`). Poll GoTrue's
  // own health endpoint so a not-ready stack fails loudly here instead of as a
  // misleading "no email arrived".
  const deadline = Date.now() + 30_000;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/auth/v1/health`, {
        headers: { apikey: anonKey },
      });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  fail(`GoTrue /auth/v1/health did not become ready within 30s (${lastErr}).`);
}

async function requestOtp({ apiUrl, anonKey, email }) {
  const res = await fetch(`${apiUrl}/auth/v1/otp`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, create_user: true }),
  });
  const text = await res.text();
  if (!res.ok) {
    fail(`OTP request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  log(`OTP requested for ${email} (HTTP ${res.status}).`);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.json();
}

function recipientMatches(to, email) {
  if (!Array.isArray(to)) return false;
  const target = email.toLowerCase();
  return to.some((entry) => {
    const addr = (entry?.Address ?? entry?.address ?? entry?.mailbox ?? "")
      .toLowerCase();
    return addr === target;
  });
}

/**
 * Fetch the delivered message from the local mail catcher, normalized to
 * { subject, text, html }. Supabase's CLI has shipped BOTH Inbucket (older) and
 * Mailpit (2.9x+) on the same [inbucket] port, so support both APIs.
 */
async function findDelivered({ catcherUrl, email }) {
  // --- Mailpit: shared catch-all, filter by recipient. ---
  let mailpitList = null;
  try {
    mailpitList = await fetchJson(`${catcherUrl}/api/v1/messages?limit=200`);
  } catch {
    mailpitList = null;
  }
  if (mailpitList && Array.isArray(mailpitList.messages)) {
    const mine = mailpitList.messages.filter((m) => recipientMatches(m.To, email));
    if (mine.length === 0) return null;
    // Mailpit lists newest first.
    const newest = mine[0];
    const detail = await fetchJson(`${catcherUrl}/api/v1/message/${encodeURIComponent(newest.ID)}`);
    if (!detail) return null;
    return {
      subject: detail.Subject ?? newest.Subject ?? "",
      text: detail.Text ?? "",
      html: detail.HTML ?? "",
    };
  }

  // --- Inbucket fallback: per-mailbox, keyed by full address or local part. ---
  const local = email.split("@")[0];
  for (const mailbox of Array.from(new Set([email, local]))) {
    let list = null;
    try {
      list = await fetchJson(`${catcherUrl}/api/v1/mailbox/${encodeURIComponent(mailbox)}`);
    } catch {
      list = null;
    }
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
      const newest = sorted[sorted.length - 1];
      const detail = await fetchJson(
        `${catcherUrl}/api/v1/mailbox/${encodeURIComponent(mailbox)}/${encodeURIComponent(newest.id)}`,
      );
      if (detail) {
        return {
          subject: detail.subject ?? newest.subject ?? "",
          text: detail.body?.text ?? "",
          html: detail.body?.html ?? "",
        };
      }
    }
  }
  return null;
}

async function waitForMessage({ catcherUrl, email }) {
  const deadline = Date.now() + INBUCKET_POLL_MS;
  while (Date.now() < deadline) {
    let delivered = null;
    try {
      delivered = await findDelivered({ catcherUrl, email });
    } catch {
      delivered = null; // transient during boot; keep polling
    }
    if (delivered) return delivered;
    await sleep(INBUCKET_POLL_INTERVAL_MS);
  }
  fail(
    `No email arrived for ${email} within ${INBUCKET_POLL_MS / 1000}s. ` +
      `Is SMTP -> the local mail catcher wired and the templates valid?`,
  );
}

function extractOtp(delivered) {
  const haystack = `${delivered.subject}\n${delivered.text}\n${delivered.html}`;
  // otp_length is 8; match a standalone run of exactly OTP_LENGTH digits.
  const re = new RegExp(`(?<!\\d)(\\d{${OTP_LENGTH}})(?!\\d)`);
  const match = haystack.match(re);
  return match ? match[1] : null;
}

async function verifyOtp({ apiUrl, anonKey, email, token }) {
  // Mirror the frontend: try type "email", then fall back to signup/magiclink.
  const types = ["email", "signup", "magiclink"];
  let lastErr = "";
  for (const type of types) {
    const res = await fetch(`${apiUrl}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type, email, token }),
    });
    const text = await res.text();
    if (res.ok) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
      return { type, session: parsed };
    }
    lastErr = `type=${type} -> HTTP ${res.status} ${text.slice(0, 200)}`;
  }
  fail(`verify failed for all types. Last: ${lastErr}`);
}

async function main() {
  const { apiUrl, anonKey, catcherUrl } = resolveConfig();
  log(`API: ${apiUrl}`);
  log(`Mail catcher: ${catcherUrl}`);

  await waitForAuthReady({ apiUrl, anonKey });

  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `auth-smoke-${unique}@instafy-smoke.test`;

  await requestOtp({ apiUrl, anonKey, email });

  const delivered = await waitForMessage({ catcherUrl, email });
  log(`Email delivered | subject: ${delivered.subject}`);

  // Assert OUR custom template rendered, not the stock GoTrue body. The footer
  // "Sent by Instafy" lives only in our HTML template files — it is NOT the
  // config-driven subject line, and stock GoTrue never emits it — so finding it
  // in the HTML body specifically proves the custom template loaded. (A weaker
  // /instafy/ check would pass on a stock link-body too, since site_url and the
  // subject both contain "instafy".)
  if (!/Sent by Instafy/i.test(delivered.html)) {
    fail(
      "Delivered email HTML lacks our template footer 'Sent by Instafy' — " +
        "the custom auth template did not render (stock/broken fallback?).",
    );
  }

  const token = extractOtp(delivered);
  if (!token) {
    fail(
      `Could not extract a ${OTP_LENGTH}-digit code from the email. Subject: ${delivered.subject}`,
    );
  }
  log(`Extracted ${OTP_LENGTH}-digit code from the email.`);

  const { type, session } = await verifyOtp({ apiUrl, anonKey, email, token });
  const accessToken = session?.access_token;
  const user = session?.user;
  if (!accessToken || !user) {
    fail(`verify (type=${type}) returned no session/user.`);
  }
  if ((user.email || "").toLowerCase() !== email.toLowerCase()) {
    fail(`Session user email mismatch: got ${user.email}, expected ${email}`);
  }

  log(
    `PASS: signup -> Instafy email -> ${OTP_LENGTH}-digit code -> verify (type=${type}) -> activated session for ${user.email}.`,
  );
  process.exit(0);
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
