import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasCliFlag, resolveFrontendProdEnv } from "./prod-env.mjs";

function withTempProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-prod-env-"));
  const frontendDir = path.join(root, "packages", "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });
  try {
    return fn({ root, frontendDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeEnv(filePath, values) {
  fs.writeFileSync(
    filePath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
}

const noNetworkEnv = {
  DEV_PROD_AUTO_REFRESH_SUPABASE_ANON: "0",
};
const clientServiceRoleKey = ["VITE", "PRIVATE", "SERVICE", "ROLE", "KEY"].join("_");

test("hasCliFlag handles split and equals-style flags", () => {
  assert.equal(hasCliFlag(["--port", "4174"], "--port"), true);
  assert.equal(hasCliFlag(["--port=4174"], "--port"), true);
  assert.equal(hasCliFlag(["--portish=4174"], "--port"), false);
});

test("resolveFrontendProdEnv uses hosted Supabase env by default", () =>
  withTempProject(async ({ root, frontendDir }) => {
    writeEnv(path.join(root, ".env.supabase"), {
      VITE_SUPABASE_URL: "https://hosted.example",
      VITE_SUPABASE_ANON_KEY: "hosted-anon",
      SUPABASE_SERVICE_ROLE_KEY: "hosted-service",
      [clientServiceRoleKey]: "hosted-vite-service",
      SERVICE_ROLE_KEY: "hosted-generic-service",
      PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY: "hosted-playwright-service",
    });
    writeEnv(path.join(root, ".env.supabase.local"), {
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_ANON_KEY: "local-anon",
      SUPABASE_SERVICE_ROLE_KEY: "local-service",
    });

    const { env, supabaseSource } = await resolveFrontendProdEnv({
      frontendDir,
      repoRoot: root,
      processEnv: noNetworkEnv,
    });

    assert.equal(supabaseSource, "prod");
    assert.equal(env.VITE_SUPABASE_URL, "https://hosted.example");
    assert.equal(env.VITE_SUPABASE_ANON_KEY, "hosted-anon");
    assert.equal(env[clientServiceRoleKey], undefined);
    assert.equal(env.PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.equal(env.SERVICE_ROLE_KEY, undefined);
    assert.equal(env.VITE_CONTROLLER_URL, "https://controller.instafy.dev");
  }));

test("resolveFrontendProdEnv can target local Supabase explicitly", () =>
  withTempProject(async ({ root, frontendDir }) => {
    writeEnv(path.join(root, ".env.supabase"), {
      VITE_SUPABASE_URL: "https://hosted.example",
      VITE_SUPABASE_ANON_KEY: "hosted-anon",
    });
    writeEnv(path.join(root, ".env.supabase.local"), {
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_ANON_KEY: "local-anon",
    });

    const { env, supabaseSource } = await resolveFrontendProdEnv({
      frontendDir,
      repoRoot: root,
      processEnv: {
        ...noNetworkEnv,
        DEV_PROD_SUPABASE_SOURCE: "local",
      },
    });

    assert.equal(supabaseSource, "local");
    assert.equal(env.VITE_SUPABASE_URL, "http://127.0.0.1:54321");
    assert.equal(env.VITE_SUPABASE_ANON_KEY, "local-anon");
  }));

test("resolveFrontendProdEnv reads hosted values from INSTAFY_ENV_DIR", () =>
  withTempProject(async ({ root, frontendDir }) => {
    const externalEnvDir = path.join(path.dirname(root), `${path.basename(root)}-external`);
    fs.mkdirSync(externalEnvDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(externalEnvDir, 0o700);
    try {
      const externalEnvFile = path.join(externalEnvDir, ".env.supabase");
      writeEnv(externalEnvFile, {
        VITE_SUPABASE_URL: "https://external-hosted.example",
        VITE_SUPABASE_ANON_KEY: "external-hosted-anon",
      });
      if (process.platform !== "win32") fs.chmodSync(externalEnvFile, 0o600);

      const { env, supabaseSource } = await resolveFrontendProdEnv({
        frontendDir,
        repoRoot: root,
        processEnv: {
          ...noNetworkEnv,
          INSTAFY_ENV_DIR: externalEnvDir,
        },
      });

      assert.equal(supabaseSource, "prod");
      assert.equal(env.VITE_SUPABASE_URL, "https://external-hosted.example");
      assert.equal(env.VITE_SUPABASE_ANON_KEY, "external-hosted-anon");
    } finally {
      fs.rmSync(externalEnvDir, { recursive: true, force: true });
    }
  }));

test("resolveFrontendProdEnv preserves explicit shell values", () =>
  withTempProject(async ({ root, frontendDir }) => {
    writeEnv(path.join(frontendDir, ".env"), {
      VITE_CONTROLLER_URL: "https://env-file-controller.example",
      VITE_SUPABASE_URL: "https://frontend-env.example",
    });
    writeEnv(path.join(root, ".env.supabase"), {
      VITE_SUPABASE_URL: "https://hosted.example",
      VITE_SUPABASE_ANON_KEY: "hosted-anon",
    });

    const { env } = await resolveFrontendProdEnv({
      frontendDir,
      repoRoot: root,
      processEnv: {
        ...noNetworkEnv,
        VITE_CONTROLLER_URL: "https://explicit-controller.example",
        VITE_SUPABASE_URL: "https://explicit-supabase.example",
        VITE_SUPABASE_ANON_KEY: "explicit-anon",
        [clientServiceRoleKey]: "explicit-service",
        SUPABASE_SERVICE_ROLE_KEY: "explicit-server-service",
        SERVICE_ROLE_KEY: "explicit-generic-service",
        PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY: "explicit-playwright-service",
      },
    });

    assert.equal(env.VITE_CONTROLLER_URL, "https://explicit-controller.example");
    assert.equal(env.VITE_SUPABASE_URL, "https://explicit-supabase.example");
    assert.equal(env.VITE_SUPABASE_ANON_KEY, "explicit-anon");
    assert.equal(env[clientServiceRoleKey], undefined);
    assert.equal(env.PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.equal(env.SERVICE_ROLE_KEY, undefined);
  }));
