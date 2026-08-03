import test from "node:test";
import assert from "node:assert/strict";

import {
  MintError,
  REMOTE_OPT_IN_VARIABLE,
  TEST_EMAIL_DOMAIN,
  TEST_EMAIL_PREFIX,
  TEST_USER_MARKER,
  assertTargetAllowed,
  buildSessionPayload,
  buildTestEmail,
  classifySupabaseTarget,
  decodeJwtClaims,
  deriveStorageKey,
  isManagedTestEmail,
  isManagedTestOrgSlug,
  isManagedTestUser,
  normalizeSession,
  parseArgs,
  parseSupabaseUrl,
  redactSecrets,
  resolveTargetConfig,
} from "./mint-test-user.mjs";

function fakeJwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const LOCAL_SERVICE_KEY = fakeJwt({ iss: "supabase-demo", role: "service_role" });
const HOSTED_SERVICE_KEY = fakeJwt({
  iss: "supabase",
  role: "service_role",
  ref: "urxdcdbouyfuhmdnzikf",
});

/* -------------------------------------------------------------------------- */
/* storage key derivation                                                      */
/* -------------------------------------------------------------------------- */

test("deriveStorageKey matches the supabase-js default (first hostname label)", () => {
  // @supabase/supabase-js 2.75.0 SupabaseClient.js:
  //   const defaultStorageKey = `sb-${baseUrl.hostname.split('.')[0]}-auth-token`
  assert.equal(deriveStorageKey("http://127.0.0.1:54321"), "sb-127-auth-token");
  assert.equal(deriveStorageKey("http://localhost:54321"), "sb-localhost-auth-token");
  assert.equal(
    deriveStorageKey("https://urxdcdbouyfuhmdnzikf.supabase.co"),
    "sb-urxdcdbouyfuhmdnzikf-auth-token",
  );
});

test("deriveStorageKey ignores trailing slashes, paths and case", () => {
  assert.equal(deriveStorageKey("http://127.0.0.1:54321/"), "sb-127-auth-token");
  assert.equal(deriveStorageKey("http://127.0.0.1:54321///"), "sb-127-auth-token");
  assert.equal(deriveStorageKey("HTTP://LocalHost:54321"), "sb-localhost-auth-token");
});

test("deriveStorageKey rejects URLs the browser client would also reject", () => {
  assert.throws(() => deriveStorageKey(""), MintError);
  assert.throws(() => deriveStorageKey("127.0.0.1:54321"), /http:\/\/ or https:\/\//);
  assert.throws(() => deriveStorageKey("ftp://127.0.0.1"), MintError);
});

test("parseSupabaseUrl appends a trailing slash like validateSupabaseUrl", () => {
  assert.equal(parseSupabaseUrl("http://127.0.0.1:54321").toString(), "http://127.0.0.1:54321/");
});

/* -------------------------------------------------------------------------- */
/* target classification                                                       */
/* -------------------------------------------------------------------------- */

test("decodeJwtClaims reads claims and tolerates non-JWT keys", () => {
  assert.deepEqual(decodeJwtClaims(LOCAL_SERVICE_KEY), {
    iss: "supabase-demo",
    role: "service_role",
  });
  assert.equal(decodeJwtClaims("sb_secret_not_a_jwt"), null);
  assert.equal(decodeJwtClaims(undefined), null);
});

test("classifySupabaseTarget flags hosted keys and local hostnames", () => {
  const local = classifySupabaseTarget({
    supabaseUrl: "http://127.0.0.1:54321",
    serviceRoleKey: LOCAL_SERVICE_KEY,
  });
  assert.equal(local.isLocalHostname, true);
  assert.equal(local.looksHosted, false);
  assert.equal(local.projectRef, "127");

  const hosted = classifySupabaseTarget({
    supabaseUrl: "https://urxdcdbouyfuhmdnzikf.supabase.co",
    serviceRoleKey: HOSTED_SERVICE_KEY,
  });
  assert.equal(hosted.isLocalHostname, false);
  assert.equal(hosted.looksHosted, true);
  assert.equal(hosted.projectRef, "urxdcdbouyfuhmdnzikf");
  assert.equal(hosted.keyProjectRef, "urxdcdbouyfuhmdnzikf");
});

/* -------------------------------------------------------------------------- */
/* safety refusals                                                             */
/* -------------------------------------------------------------------------- */

test("local target accepts localhost forms", () => {
  for (const url of [
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://[::1]:54321",
  ]) {
    const info = assertTargetAllowed({
      target: "local",
      supabaseUrl: url,
      serviceRoleKey: LOCAL_SERVICE_KEY,
      env: {},
    });
    assert.equal(info.isLocalHostname, true);
  }
});

test("local target refuses a non-local Supabase URL", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "local",
        supabaseUrl: "https://urxdcdbouyfuhmdnzikf.supabase.co",
        serviceRoleKey: HOSTED_SERVICE_KEY,
        env: {},
      }),
    (error) => {
      assert.ok(error instanceof MintError);
      assert.equal(error.code, "non_local_target");
      assert.match(error.message, /REFUSING TO RUN/);
      return true;
    },
  );
});

test("local target refuses a hosted admin key even when the URL is local", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "local",
        supabaseUrl: "http://127.0.0.1:54321",
        serviceRoleKey: HOSTED_SERVICE_KEY,
        env: {},
      }),
    (error) => {
      assert.equal(error.code, "hosted_key_for_local_target");
      return true;
    },
  );
});

test("the opt-in env var alone does not unlock a non-local URL", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "local",
        supabaseUrl: "https://urxdcdbouyfuhmdnzikf.supabase.co",
        serviceRoleKey: HOSTED_SERVICE_KEY,
        env: { [REMOTE_OPT_IN_VARIABLE]: "urxdcdbouyfuhmdnzikf" },
      }),
    { code: "non_local_target" },
  );
});

test("remote target refuses without the opt-in env var", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "remote",
        supabaseUrl: "https://urxdcdbouyfuhmdnzikf.supabase.co",
        serviceRoleKey: HOSTED_SERVICE_KEY,
        env: {},
      }),
    { code: "missing_remote_opt_in" },
  );
});

test("remote target refuses when the opt-in ref does not match the URL", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "remote",
        supabaseUrl: "https://urxdcdbouyfuhmdnzikf.supabase.co",
        serviceRoleKey: HOSTED_SERVICE_KEY,
        env: { [REMOTE_OPT_IN_VARIABLE]: "someotherproject" },
      }),
    { code: "remote_opt_in_mismatch" },
  );
});

test("remote target refuses when the admin key belongs to another project", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "remote",
        supabaseUrl: "https://staging-ref.supabase.co",
        serviceRoleKey: HOSTED_SERVICE_KEY,
        env: { [REMOTE_OPT_IN_VARIABLE]: "staging-ref" },
      }),
    { code: "remote_key_mismatch" },
  );
});

test("remote target is allowed only with both opt-ins aligned", () => {
  const info = assertTargetAllowed({
    target: "remote",
    supabaseUrl: "https://urxdcdbouyfuhmdnzikf.supabase.co",
    serviceRoleKey: HOSTED_SERVICE_KEY,
    env: { [REMOTE_OPT_IN_VARIABLE]: "urxdcdbouyfuhmdnzikf" },
  });
  assert.equal(info.projectRef, "urxdcdbouyfuhmdnzikf");
});

test("remote target refuses a localhost URL", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "remote",
        supabaseUrl: "http://127.0.0.1:54321",
        serviceRoleKey: LOCAL_SERVICE_KEY,
        env: { [REMOTE_OPT_IN_VARIABLE]: "127" },
      }),
    { code: "remote_target_is_local" },
  );
});

test("an unknown target is refused", () => {
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "staging",
        supabaseUrl: "http://127.0.0.1:54321",
        serviceRoleKey: LOCAL_SERVICE_KEY,
        env: {},
      }),
    { code: "unknown_target" },
  );
});

/* -------------------------------------------------------------------------- */
/* configuration resolution                                                    */
/* -------------------------------------------------------------------------- */

test("local target prefers `supabase status` over hosted process.env values", () => {
  const hostileEnv = {
    SUPABASE_PROJECT_URL: "https://urxdcdbouyfuhmdnzikf.supabase.co",
    VITE_SUPABASE_URL: "https://urxdcdbouyfuhmdnzikf.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: HOSTED_SERVICE_KEY,
    SERVICE_ROLE_KEY: HOSTED_SERVICE_KEY,
  };
  const statusEnv = {
    API_URL: "http://127.0.0.1:54321",
    SERVICE_ROLE_KEY: LOCAL_SERVICE_KEY,
    ANON_KEY: fakeJwt({ iss: "supabase-demo", role: "anon" }),
  };

  const config = resolveTargetConfig({ target: "local", env: hostileEnv, statusEnv });
  assert.equal(config.source, "supabase status");
  assert.equal(config.supabaseUrl, "http://127.0.0.1:54321");
  assert.equal(config.serviceRoleKey, LOCAL_SERVICE_KEY);

  // And the safety gate still passes for the status-derived pair.
  assert.equal(
    assertTargetAllowed({
      target: "local",
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
      env: hostileEnv,
    }).isLocalHostname,
    true,
  );
});

test("without a running local stack the hostile env is resolved and then refused", () => {
  const hostileEnv = {
    SUPABASE_PROJECT_URL: "https://urxdcdbouyfuhmdnzikf.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: HOSTED_SERVICE_KEY,
  };
  const config = resolveTargetConfig({ target: "local", env: hostileEnv, statusEnv: null });
  assert.equal(config.source, "process.env");
  assert.throws(
    () =>
      assertTargetAllowed({
        target: "local",
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.serviceRoleKey,
        env: hostileEnv,
      }),
    { code: "non_local_target" },
  );
});

test("resolveTargetConfig never mixes status and process.env sources", () => {
  const config = resolveTargetConfig({
    target: "local",
    env: { SUPABASE_SERVICE_ROLE_KEY: HOSTED_SERVICE_KEY },
    statusEnv: { API_URL: "http://127.0.0.1:54321", SERVICE_ROLE_KEY: LOCAL_SERVICE_KEY },
  });
  assert.equal(config.serviceRoleKey, LOCAL_SERVICE_KEY);
});

/* -------------------------------------------------------------------------- */
/* argument parsing                                                            */
/* -------------------------------------------------------------------------- */

test("parseArgs defaults to the local target with org seeding on", () => {
  const options = parseArgs([]);
  assert.equal(options.target, "local");
  assert.equal(options.seedOrg, true);
  assert.equal(options.json, false);
});

test("parseArgs leaves org seeding off for a remote target unless asked", () => {
  assert.equal(parseArgs(["--target", "remote"]).seedOrg, false);
  assert.equal(parseArgs(["--target=remote", "--seed-org"]).seedOrg, true);
  assert.equal(parseArgs(["--no-seed-org"]).seedOrg, false);
});

test("parseArgs refuses bulk cleanup against a remote target", () => {
  assert.throws(
    () => parseArgs(["--target", "remote", "--cleanup-all-test-users"]),
    { code: "bulk_cleanup_remote" },
  );
});

test("parseArgs collects repeatable cleanup ids and rejects junk", () => {
  const options = parseArgs(["--cleanup", "a", "--cleanup=b", "--json"]);
  assert.deepEqual(options.cleanupUserIds, ["a", "b"]);
  assert.equal(options.json, true);
  assert.throws(() => parseArgs(["--cleanup"]), { code: "bad_usage" });
  assert.throws(() => parseArgs(["--nope"]), { code: "bad_usage" });
});

/* -------------------------------------------------------------------------- */
/* managed-resource recognition                                                */
/* -------------------------------------------------------------------------- */

test("generated emails are recognized as managed test users", () => {
  const email = buildTestEmail();
  assert.ok(email.startsWith(TEST_EMAIL_PREFIX));
  assert.ok(email.endsWith(`@${TEST_EMAIL_DOMAIN}`));
  assert.equal(isManagedTestEmail(email), true);
  assert.equal(isManagedTestEmail("someone@instafy.com"), false);
  assert.equal(isManagedTestEmail("playwright@instafy.dev"), false);
});

test("cleanup only recognizes users carrying this tool's metadata marker", () => {
  assert.equal(isManagedTestUser({ user_metadata: { [TEST_USER_MARKER]: true } }), true);
  assert.equal(isManagedTestUser({ user_metadata: { [TEST_USER_MARKER]: "true" } }), false);
  assert.equal(isManagedTestUser({ user_metadata: {} }), false);
  assert.equal(isManagedTestUser({}), false);
  assert.equal(isManagedTestUser(null), false);
});

test("only this tool's org slugs are considered deletable", () => {
  assert.equal(isManagedTestOrgSlug("agent-test-abc123"), true);
  assert.equal(isManagedTestOrgSlug("dev"), false);
  assert.equal(isManagedTestOrgSlug(""), false);
});

/* -------------------------------------------------------------------------- */
/* session shape                                                               */
/* -------------------------------------------------------------------------- */

test("normalizeSession fills expires_at from expires_in when GoTrue omits it", () => {
  const session = normalizeSession(
    {
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      user: { id: "user-1", email: "a@b.local" },
    },
    { nowMs: 1_700_000_000_000 },
  );
  assert.equal(session.expires_at, 1_700_000_000 + 3600);
  assert.equal(session.token_type, "bearer");
});

test("normalizeSession keeps a server-provided expires_at and rejects broken responses", () => {
  const session = normalizeSession({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: 42,
    user: { id: "user-1" },
  });
  assert.equal(session.expires_at, 42);
  assert.throws(() => normalizeSession(null), { code: "invalid_token_response" });
  assert.throws(
    () => normalizeSession({ access_token: "a", refresh_token: "b", user: null }),
    { code: "invalid_token_response" },
  );
});

test("buildSessionPayload emits the persisted localStorage row auth-js validates", () => {
  const session = normalizeSession({
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    expires_at: 1_700_003_600,
    user: { id: "user-1", email: "agent@instafy.local" },
  });
  const payload = buildSessionPayload({
    session,
    supabaseUrl: "http://127.0.0.1:54321",
    target: "local",
    password: "pw",
  });

  assert.equal(payload.storageKey, "sb-127-auth-token");
  assert.equal(payload.userId, "user-1");
  assert.equal(payload.email, "agent@instafy.local");
  assert.equal(payload.supabaseUrl, "http://127.0.0.1:54321");

  // auth-js _isValidSession requires exactly these three fields to be present.
  const parsed = JSON.parse(payload.localStorageValue);
  for (const field of ["access_token", "refresh_token", "expires_at"]) {
    assert.ok(field in parsed, `${field} must survive into localStorage`);
  }
  // A missing user turns into a proxy that throws on access, so keep it whole.
  assert.deepEqual(parsed.user, { id: "user-1", email: "agent@instafy.local" });
});

/* -------------------------------------------------------------------------- */
/* redaction                                                                   */
/* -------------------------------------------------------------------------- */

test("redactSecrets strips the admin key out of diagnostics", () => {
  const message = `boom ${HOSTED_SERVICE_KEY} boom`;
  const redacted = redactSecrets(message, [HOSTED_SERVICE_KEY]);
  assert.equal(redacted.includes(HOSTED_SERVICE_KEY), false);
  assert.match(redacted, /\[redacted\]/);
  // Short/blank values must not turn the whole string into noise.
  assert.equal(redactSecrets("hello", ["", "abc"]), "hello");
});

test("the printed payload never contains the service-role key", () => {
  const session = normalizeSession({
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    user: { id: "user-1", email: "agent@instafy.local" },
  });
  const payload = buildSessionPayload({
    session,
    supabaseUrl: "http://127.0.0.1:54321",
    target: "local",
    password: "pw",
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(LOCAL_SERVICE_KEY), false);
  assert.equal(serialized.includes(HOSTED_SERVICE_KEY), false);
  assert.equal(Object.keys(payload).includes("serviceRoleKey"), false);
});
