import assert from "node:assert/strict";
import test from "node:test";

import {
  controllerHoldsHookSecret,
  localBrokerHookEnv,
  localPreviewEnv,
  localPreviewsEnabled,
  tunnelBrokerStartPlan,
} from "./localTunnelBroker.mjs";

const controllerPort = 8788;
const secret = () => "s3cret";
const neverAsked = () => {
  throw new Error("no hook secret should be resolved");
};

test("the broker calls both controller hooks with the controller's hook secret", () => {
  assert.deepEqual(localBrokerHookEnv({ env: {}, controllerPort: 9788, resolveHookSecret: secret }), {
    ACL_HOOK_URL: "http://host.docker.internal:9788/tunnel-broker/hooks/acl",
    ACL_HOOK_TOKEN: "s3cret",
    EVENT_HOOK_URL: "http://host.docker.internal:9788/tunnel-broker/hooks/events",
    EVENT_HOOK_TOKEN: "s3cret",
    TUNNEL_BROKER_HOOK_SECRET: "s3cret",
  });
});

test("a hook secret or hook URL already set wins, and one given token is used for all three", () => {
  const env = localBrokerHookEnv({
    env: { ACL_HOOK_TOKEN: " from-broker ", ACL_HOOK_URL: "http://controller.test/tunnel-broker/hooks/acl" },
    controllerPort,
    resolveHookSecret: neverAsked,
  });
  assert.equal(env.ACL_HOOK_URL, "http://controller.test/tunnel-broker/hooks/acl");
  assert.equal(env.EVENT_HOOK_URL, "http://host.docker.internal:8788/tunnel-broker/hooks/events");
  assert.equal(env.TUNNEL_BROKER_HOOK_SECRET, "from-broker");
  assert.equal(env.EVENT_HOOK_TOKEN, "from-broker");
});

test("hook tokens that differ from the controller's secret refuse to start, naming no value", () => {
  assert.throws(
    () =>
      localBrokerHookEnv({
        env: { TUNNEL_BROKER_HOOK_SECRET: "controller-value", ACL_HOOK_TOKEN: "broker-value" },
        controllerPort,
        resolveHookSecret: neverAsked,
      }),
    (error) =>
      /must match/.test(error.message) &&
      !error.message.includes("controller-value") &&
      !error.message.includes("broker-value")
  );
});

test("previews are served on preview.localhost through the local Traefik", () => {
  assert.deepEqual(localPreviewEnv({ env: {}, controllerPort }), {
    PREVIEW_DOMAIN: "preview.localhost",
    PREVIEW_BASE_URL: "http://preview.localhost:8083",
    PREVIEW_AUTH_ADDRESS: "http://broker:8080",
    PREVIEW_AUTH_HOOK_URL: "http://host.docker.internal:8788/tunnel-broker/hooks/preview-auth",
  });
  const custom = localPreviewEnv({ env: { PREVIEW_DOMAIN: " previews.test " }, controllerPort });
  assert.equal(custom.PREVIEW_DOMAIN, "previews.test");
  assert.equal(custom.PREVIEW_BASE_URL, "http://previews.test:8083");
});

test("an empty PREVIEW_DOMAIN turns previews off and leaves the hooks on", () => {
  assert.equal(localPreviewsEnabled({ PREVIEW_DOMAIN: "" }), false);
  assert.equal(localPreviewsEnabled({}), true);
  assert.deepEqual(localPreviewEnv({ env: { PREVIEW_DOMAIN: "  " }, controllerPort }), {});

  const plan = tunnelBrokerStartPlan({ env: { PREVIEW_DOMAIN: "" }, controllerPort, resolveHookSecret: secret });
  assert.equal(plan.broker.ACL_HOOK_URL, "http://host.docker.internal:8788/tunnel-broker/hooks/acl");
  assert.equal(plan.controller.TUNNEL_BROKER_HOOK_SECRET, "s3cret");
  assert.equal(Object.keys(plan.broker).some((key) => key.startsWith("PREVIEW_")), false);
  assert.equal(Object.keys(plan.controller).some((key) => key.startsWith("PREVIEW_")), false);
});

test("a broker the launcher starts gets hooks and previews; the controller only what it reads", () => {
  const plan = tunnelBrokerStartPlan({ env: {}, controllerPort, resolveHookSecret: secret });
  assert.equal(plan.action, "start");
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.controller, {
    TUNNEL_BROKER_HOOK_SECRET: "s3cret",
    PREVIEW_DOMAIN: "preview.localhost",
    PREVIEW_BASE_URL: "http://preview.localhost:8083",
  });
  assert.deepEqual(Object.keys(plan.broker).sort(), [
    "ACL_HOOK_TOKEN",
    "ACL_HOOK_URL",
    "EVENT_HOOK_TOKEN",
    "EVENT_HOOK_URL",
    "PREVIEW_AUTH_ADDRESS",
    "PREVIEW_AUTH_HOOK_URL",
    "PREVIEW_DOMAIN",
  ]);
});

test("a skipped or external broker gets nothing, and no secret is made", () => {
  for (const env of [{ RUNTIME_SKIP_TUNNEL_BROKER: "1" }, { TUNNEL_BROKER_BASE_URL: "https://broker.test" }]) {
    const plan = tunnelBrokerStartPlan({ env, controllerPort, resolveHookSecret: neverAsked });
    assert.deepEqual(plan.broker, {});
    assert.deepEqual(plan.controller, {});
  }
  assert.equal(
    tunnelBrokerStartPlan({ env: { RUNTIME_SKIP_TUNNEL_BROKER: "1" }, controllerPort, resolveHookSecret: neverAsked }).action,
    "skip"
  );
  assert.equal(
    tunnelBrokerStartPlan({ env: { TUNNEL_BROKER_BASE_URL: "https://broker.test" }, controllerPort, resolveHookSecret: neverAsked }).action,
    "external"
  );
});

test("with a controller the launcher does not start, hooks need a secret given for both", () => {
  const unknown = tunnelBrokerStartPlan({
    env: { RUNTIME_SKIP_CONTROLLER: "1" },
    controllerPort,
    resolveHookSecret: neverAsked,
  });
  assert.equal(unknown.action, "start");
  assert.deepEqual(unknown.broker, {});
  assert.deepEqual(unknown.controller, {});
  assert.match(unknown.warnings.join("\n"), /RUNTIME_SKIP_CONTROLLER=1.*TUNNEL_BROKER_HOOK_SECRET/);

  const given = tunnelBrokerStartPlan({
    env: { RUNTIME_SKIP_CONTROLLER: "1", TUNNEL_BROKER_HOOK_SECRET: "shared" },
    controllerPort,
    resolveHookSecret: neverAsked,
  });
  assert.equal(given.broker.ACL_HOOK_TOKEN, "shared");
  assert.equal(given.broker.PREVIEW_DOMAIN, "preview.localhost");
  assert.deepEqual(given.warnings, []);
});

test("a running controller is reused only when it accepts the hook secret", async () => {
  const requests = [];
  const answering = (status) => async (url, init) => {
    requests.push({ url, init });
    return { status };
  };

  assert.equal(await controllerHoldsHookSecret({ baseUrl: "http://c.test", secret: "s3cret", fetchImpl: answering(400) }), true);
  const { url, init } = requests[0];
  assert.equal(url, "http://c.test/tunnel-broker/hooks/acl");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer s3cret");
  assert.equal(JSON.parse(init.body).project_id, "");

  // 401: a different secret. 503: none (a controller from before the hooks were wired).
  for (const status of [401, 503, 404, 500, 200]) {
    assert.equal(
      await controllerHoldsHookSecret({ baseUrl: "http://c.test", secret: "s3cret", fetchImpl: answering(status) }),
      false,
      `status ${status}`
    );
  }
  const unreachable = async () => {
    throw new Error("connection refused");
  };
  assert.equal(await controllerHoldsHookSecret({ baseUrl: "http://c.test", secret: "s3cret", fetchImpl: unreachable }), false);
});
