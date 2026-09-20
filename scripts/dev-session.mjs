#!/usr/bin/env node
// Mint a throwaway signed-in session against the LOCAL Supabase, so an agent
// working on this repo can reach the studio without a human typing a password.
//
// The mechanism is the one the Playwright harness already uses and maintains
// (tests/playwright/utils/harness.ts): create a confirmed user through the
// admin API with the service-role key, then exchange it for a session. The
// only new thing here is that it is reachable outside a test run.
//
// This is deliberately local-only. It refuses to run against a host that is
// not loopback, because a service-role key is the key to every account: used
// anywhere real it would be a way into somebody else's workspace rather than a
// development convenience. The guard is the point of the script, not a detail.
//
//   node scripts/dev-session.mjs                 # print the session as JSON
//   node scripts/dev-session.mjs --storage       # print the localStorage entry
//   node scripts/dev-session.mjs --email a@b.dev # reuse a fixed account
//
// With --storage the output is {key, value}: write value at key in the origin's
// localStorage and reload, and the app is signed in.

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

function fromSupabaseStatus() {
  try {
    const out = execFileSync("pnpm", ["exec", "supabase", "--workdir", "supabase", "status", "--output", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const read = (name) => out.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, "m"))?.[1] ?? null;
    return {
      url: read("API_URL"),
      anonKey: read("ANON_KEY"),
      serviceKey: read("SERVICE_ROLE_KEY"),
    };
  } catch {
    return { url: null, anonKey: null, serviceKey: null };
  }
}

function resolve() {
  const fallback = fromSupabaseStatus();
  const url =
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || fallback.url || "http://127.0.0.1:54321";
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || fallback.anonKey;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || fallback.serviceKey;
  return { url, anonKey, serviceKey };
}

function assertLocal(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a URL: ${url}`);
  }
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `refusing to mint a session against ${host}. This script uses the service-role key, ` +
        `which can sign in as anyone, so it runs against a loopback Supabase only.`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantStorage = args.includes("--storage");
  const emailArg = args.indexOf("--email");
  const { url, anonKey, serviceKey } = resolve();

  assertLocal(url);
  if (!anonKey) throw new Error("no anon key: set SUPABASE_ANON_KEY or start the local stack");
  if (!serviceKey) throw new Error("no service-role key: set SUPABASE_SERVICE_ROLE_KEY or start the local stack");

  const email = emailArg >= 0 ? args[emailArg + 1] : `agent+${randomUUID()}@instafy.dev`;
  const password = `Agent-${randomUUID()}!aA1`;

  // A fixed --email may already exist, which is fine: the sign-in below is what
  // matters, and a 422 here means "already there" rather than a failure.
  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok && created.status !== 422) {
    throw new Error(`admin user create failed: ${created.status} ${await created.text()}`);
  }

  const signedIn = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signedIn.ok) {
    throw new Error(`sign-in failed: ${signedIn.status} ${await signedIn.text()}`);
  }
  const session = await signedIn.json();

  if (wantStorage) {
    // supabase-js derives its storage key from the project ref, and the shape
    // it picks for a loopback host is not worth second-guessing from here: an
    // IPv4 stack writes sb-127-auth-token while an IPv6 one does not match the
    // same rule. So keyHint is a hint. The reliable move for a caller is to
    // read the single existing sb-*-auth-token key out of localStorage and
    // replace its value, falling back to the hint when the origin has never
    // been signed in.
    const ref = new URL(url).hostname.split(".")[0];
    process.stdout.write(
      `${JSON.stringify({ keyHint: `sb-${ref}-auth-token`, value: JSON.stringify(session), email }, null, 2)}\n`
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        email,
        userId: session.user?.id ?? null,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresIn: session.expires_in,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
