import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseShellEnv,
  primeProcessEnvFromLocalSupabase,
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseAnonKey,
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseDbUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "./localSupabaseEnv.mjs";

const browserServiceRoleAlias = [
  "VITE",
  "SUPABASE",
  "SERVICE",
  "ROLE",
  "KEY",
].join("_");

function withFakePnpm(scriptBody, fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-local-supabase-env-"));
  const pnpmPath = path.join(binDir, "pnpm");
  fs.writeFileSync(
    pnpmPath,
    `#!/bin/sh
${scriptBody}
`,
    { encoding: "utf-8", mode: 0o755 },
  );
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test("parseShellEnv handles comments and quoted values", () => {
  const env = parseShellEnv(`
# comment
API_URL="http://127.0.0.1:54321"
DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
SERVICE_ROLE_KEY='service-role'
`);

  assert.equal(env.API_URL, "http://127.0.0.1:54321");
  assert.equal(env.DB_URL, "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  assert.equal(env.SERVICE_ROLE_KEY, "service-role");
});

test("readLocalSupabaseStatusEnv returns parsed env when pnpm succeeds", () =>
  withFakePnpm(
    `printf 'API_URL="http://127.0.0.1:54321"\\nSERVICE_ROLE_KEY=service-role\\nDB_URL=db-url\\n'`,
    () => {
      const env = readLocalSupabaseStatusEnv({ cwd: process.cwd(), required: true });
      assert.equal(env.API_URL, "http://127.0.0.1:54321");
      assert.equal(env.SERVICE_ROLE_KEY, "service-role");
      assert.equal(env.DB_URL, "db-url");
    },
  ));

test("readLocalSupabaseStatusEnv returns null when optional and pnpm fails", () =>
  withFakePnpm(`echo "boom" >&2\nexit 1`, () => {
    assert.equal(
      readLocalSupabaseStatusEnv({ cwd: process.cwd(), required: false }),
      null,
    );
  }));

test("readLocalSupabaseStatusEnv throws when required and pnpm fails", () =>
  withFakePnpm(`echo "boom" >&2\nexit 1`, () => {
    assert.throws(
      () => readLocalSupabaseStatusEnv({ cwd: process.cwd(), required: true }),
      /pnpm supabase:up/,
    );
  }));

test("readLocalSupabaseStatusEnv bounds a hung local CLI", () =>
  withFakePnpm(`exec sleep 2`, () => {
    assert.equal(
      readLocalSupabaseStatusEnv({
        cwd: process.cwd(),
        required: false,
        timeoutMs: 50,
      }),
      null,
    );
    assert.throws(
      () =>
        readLocalSupabaseStatusEnv({
          cwd: process.cwd(),
          required: true,
          timeoutMs: 50,
        }),
      /timed out after 50ms/,
    );
  }));

test("resolve helpers prefer explicit env over local status env", () => {
  const env = {
    TEST_DATABASE_URL: "explicit-test-db",
    SUPABASE_PROJECT_URL: "https://explicit.example",
    VITE_SUPABASE_ANON_KEY: "explicit-anon",
    SERVICE_ROLE_KEY: "explicit-service",
  };
  const statusEnv = {
    DB_URL: "status-db",
    API_URL: "http://127.0.0.1:54321",
    ANON_KEY: "status-anon",
    SERVICE_ROLE_KEY: "status-service",
  };

  assert.equal(resolveLocalSupabaseDbUrl({ env, statusEnv }), "explicit-test-db");
  assert.equal(resolveLocalSupabaseApiUrl({ env, statusEnv }), "https://explicit.example");
  assert.equal(resolveLocalSupabaseAnonKey({ env, statusEnv }), "explicit-anon");
  assert.equal(resolveLocalSupabaseServiceRoleKey({ env, statusEnv }), "explicit-service");
});

test("resolve helpers fall back to local status env when explicit env is blank", () => {
  const env = {};
  const statusEnv = {
    DB_URL: "status-db",
    API_URL: "http://127.0.0.1:54321",
    ANON_KEY: "status-anon",
    SERVICE_ROLE_KEY: "status-service",
  };

  assert.equal(resolveLocalSupabaseDbUrl({ env, statusEnv }), "status-db");
  assert.equal(resolveLocalSupabaseApiUrl({ env, statusEnv }), "http://127.0.0.1:54321");
  assert.equal(resolveLocalSupabaseAnonKey({ env, statusEnv }), "status-anon");
  assert.equal(resolveLocalSupabaseServiceRoleKey({ env, statusEnv }), "status-service");
});

test("service-role resolution ignores browser-exposed aliases", () => {
  const env = {
    [browserServiceRoleAlias]: "browser-service",
  };
  assert.equal(resolveLocalSupabaseServiceRoleKey({ env }), "");
  assert.equal(
    resolveLocalSupabaseServiceRoleKey({
      env,
      statusEnv: { SERVICE_ROLE_KEY: "status-service" },
    }),
    "status-service",
  );
});

test("primeProcessEnvFromLocalSupabase fills blanks only and preserves explicit env", () =>
  withFakePnpm(
    `printf 'API_URL=http://127.0.0.1:54321\\nANON_KEY=status-anon\\nSERVICE_ROLE_KEY=status-service\\n'`,
    () => {
      const targetEnv = {
        VITE_SUPABASE_URL: "https://explicit.example",
        VITE_SUPABASE_ANON_KEY: "explicit-anon",
        SERVICE_ROLE_KEY: "explicit-service",
      };

      const statusEnv = primeProcessEnvFromLocalSupabase(targetEnv, {
        cwd: process.cwd(),
        fillApiUrl: true,
        fillAnonKey: true,
        fillServiceRole: true,
        required: true,
      });

      assert.equal(statusEnv.API_URL, "http://127.0.0.1:54321");
      assert.equal(targetEnv.VITE_SUPABASE_URL, "https://explicit.example");
      assert.equal(targetEnv.SUPABASE_URL, "https://explicit.example");
      assert.equal(targetEnv.SUPABASE_PROJECT_URL, "https://explicit.example");
      assert.equal(targetEnv.VITE_SUPABASE_ANON_KEY, "explicit-anon");
      assert.equal(targetEnv.SUPABASE_ANON_KEY, "explicit-anon");
      assert.equal(targetEnv.SERVICE_ROLE_KEY, "explicit-service");
      assert.equal(targetEnv.SUPABASE_SERVICE_ROLE_KEY, "explicit-service");
    },
  ));

test("optional priming skips the local CLI when every requested value is explicit", () =>
  withFakePnpm(
    `echo "local Supabase CLI should not run" >&2
exit 99`,
    () => {
      const targetEnv = {
        VITE_SUPABASE_URL: "https://production.example",
        VITE_SUPABASE_ANON_KEY: "explicit-anon",
        SUPABASE_SERVICE_ROLE_KEY: "explicit-service",
      };

      const statusEnv = primeProcessEnvFromLocalSupabase(targetEnv, {
        cwd: process.cwd(),
        fillApiUrl: true,
        fillAnonKey: true,
        fillServiceRole: true,
        required: false,
      });

      assert.equal(statusEnv, null);
      assert.equal(targetEnv.VITE_SUPABASE_URL, "https://production.example");
      assert.equal(targetEnv.SUPABASE_URL, "https://production.example");
      assert.equal(targetEnv.SUPABASE_PROJECT_URL, "https://production.example");
      assert.equal(targetEnv.VITE_SUPABASE_ANON_KEY, "explicit-anon");
      assert.equal(targetEnv.SUPABASE_ANON_KEY, "explicit-anon");
      assert.equal(targetEnv.SUPABASE_SERVICE_ROLE_KEY, "explicit-service");
      assert.equal(targetEnv.SERVICE_ROLE_KEY, "explicit-service");
    },
  ));
