import assert from "node:assert/strict";
import test from "node:test";

import { localPreviewEnv, localPreviewsEnabled } from "./localPreviewEnv.mjs";

const ports = { controllerPort: 8788, ingressPort: 8083 };

test("the local stack serves previews on preview.localhost with one hook secret", () => {
  const env = localPreviewEnv({ env: {}, ...ports, resolveHookSecret: () => "s3cret" });

  assert.deepEqual(env, {
    PREVIEW_DOMAIN: "preview.localhost",
    PREVIEW_BASE_URL: "http://preview.localhost:8083",
    PREVIEW_AUTH_ADDRESS: "http://broker:8080",
    PREVIEW_AUTH_HOOK_URL: "http://host.docker.internal:8788/tunnel-broker/hooks/preview-auth",
    ACL_HOOK_URL: "http://host.docker.internal:8788/tunnel-broker/hooks/acl",
    ACL_HOOK_TOKEN: "s3cret",
    TUNNEL_BROKER_HOOK_SECRET: "s3cret",
  });
});

test("hooks follow the controller port and viewer hosts the ingress port", () => {
  const env = localPreviewEnv({
    env: {},
    controllerPort: 9788,
    ingressPort: 9083,
    resolveHookSecret: () => "s3cret",
  });

  assert.equal(env.PREVIEW_BASE_URL, "http://preview.localhost:9083");
  assert.equal(env.PREVIEW_AUTH_HOOK_URL, "http://host.docker.internal:9788/tunnel-broker/hooks/preview-auth");
  assert.equal(env.ACL_HOOK_URL, "http://host.docker.internal:9788/tunnel-broker/hooks/acl");
});

test("values the operator set win", () => {
  const env = localPreviewEnv({
    env: {
      PREVIEW_DOMAIN: " previews.test ",
      PREVIEW_AUTH_HOOK_URL: "http://controller.test/tunnel-broker/hooks/preview-auth",
      ACL_HOOK_URL: "http://controller.test/tunnel-broker/hooks/acl",
    },
    ...ports,
    resolveHookSecret: () => "s3cret",
  });

  assert.equal(env.PREVIEW_DOMAIN, "previews.test");
  assert.equal(env.PREVIEW_BASE_URL, "http://previews.test:8083");
  assert.equal(env.PREVIEW_AUTH_HOOK_URL, "http://controller.test/tunnel-broker/hooks/preview-auth");
  assert.equal(env.ACL_HOOK_URL, "http://controller.test/tunnel-broker/hooks/acl");
});

test("an empty PREVIEW_DOMAIN turns previews off and touches no secret", () => {
  let asked = false;
  const env = localPreviewEnv({
    env: { PREVIEW_DOMAIN: "  " },
    ...ports,
    resolveHookSecret: () => {
      asked = true;
      return "s3cret";
    },
  });

  assert.deepEqual(env, {});
  assert.equal(asked, false);
  assert.equal(localPreviewsEnabled({ PREVIEW_DOMAIN: "" }), false);
  assert.equal(localPreviewsEnabled({}), true);
});
