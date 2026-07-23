import test from "node:test";
import assert from "node:assert/strict";

import {
  isIsolatedByocProxyAuthPath,
  localProxyCredentialMode,
  localProxyStaticAuthEnabled,
} from "./proxyCredentialMode.mjs";

test("local proxy defaults to controller-backed per-user credentials", () => {
  assert.equal(localProxyCredentialMode({}), "remote_dynamic");
  assert.equal(localProxyStaticAuthEnabled({}), false);
});

test("ambient machine credentials never silently select static proxy auth", () => {
  assert.equal(
    localProxyCredentialMode({
      HOME: "/safe/home",
      CODEX_HOME: "/safe/home/.codex",
      CODEX_AUTH_PATH: "/safe/home/.codex/auth.json",
      OPENAI_API_KEY: "present-but-not-selected",
    }),
    "remote_dynamic"
  );
});

test("legacy static proxy auth requires its dedicated explicit opt-in", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      localProxyCredentialMode({ RUNTIME_PROXY_STATIC_AUTH: value }),
      "remote_static"
    );
  }

  for (const value of ["", "0", "false", "no", "off", "unexpected"]) {
    assert.equal(
      localProxyCredentialMode({ RUNTIME_PROXY_STATIC_AUTH: value }),
      "remote_dynamic"
    );
  }
});

test("the removed inverse BYOC toggle cannot accidentally re-enable static auth", () => {
  assert.equal(
    localProxyCredentialMode({ RUNTIME_PROXY_BYOC: "0" }),
    "remote_dynamic"
  );
});

test("BYOC cleanup is limited to its disposable proxy directory", () => {
  const byocRoot = "/repo/tmp/proxy-codex-byoc";
  assert.equal(
    isIsolatedByocProxyAuthPath(
      "/repo/tmp/proxy-codex-byoc/auth.json",
      byocRoot
    ),
    true
  );
  assert.equal(
    isIsolatedByocProxyAuthPath("/home/user/.codex/auth.json", byocRoot),
    false
  );
  assert.equal(
    isIsolatedByocProxyAuthPath("/repo/tmp/proxy-codex/auth.json", byocRoot),
    false
  );
});
