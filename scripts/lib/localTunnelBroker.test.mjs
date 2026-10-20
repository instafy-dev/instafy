import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  controllerHoldsHookSecret,
  controllerReuseDecision,
  isLoopbackPreviewHost,
  localBrokerHookEnv,
  localPreviewEnv,
  localPreviewsEnabled,
  ownsControllerListener,
  tunnelBrokerComposeCalls,
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
  const sub = localPreviewEnv({ env: { PREVIEW_DOMAIN: "pv.dev.localhost" }, controllerPort, ingressPort: 9083 });
  assert.equal(sub.PREVIEW_BASE_URL, "http://pv.dev.localhost:9083");
});

// The controller accepts a plain-http PREVIEW_BASE_URL only on a loopback host
// (PreviewOrigin::parse in runtime-controller previews/sessions.rs) and refuses
// to start otherwise, so the launcher never derives one for any other domain.
test("a domain that is not loopback gets no derived http base URL, so the controller uses https", () => {
  const custom = localPreviewEnv({ env: { PREVIEW_DOMAIN: " previews.test " }, controllerPort });
  assert.equal(custom.PREVIEW_DOMAIN, "previews.test");
  assert.equal(Object.hasOwn(custom, "PREVIEW_BASE_URL"), false);

  const plan = tunnelBrokerStartPlan({ env: { PREVIEW_DOMAIN: "previews.test" }, controllerPort, resolveHookSecret: secret });
  assert.deepEqual(plan.controller, { TUNNEL_BROKER_HOOK_SECRET: "s3cret", PREVIEW_DOMAIN: "previews.test" });

  const https = localPreviewEnv({
    env: { PREVIEW_DOMAIN: "previews.test", PREVIEW_BASE_URL: "https://previews.test" },
    controllerPort,
  });
  assert.equal(https.PREVIEW_BASE_URL, "https://previews.test");
});

test("a given plain-http base URL on a host that is not loopback refuses to start", () => {
  assert.throws(
    () => localPreviewEnv({ env: { PREVIEW_BASE_URL: "http://previews.test:8083" }, controllerPort }),
    /plain http.*not loopback/
  );
  assert.equal(
    localPreviewEnv({ env: { PREVIEW_BASE_URL: "http://127.0.0.1:8083" }, controllerPort }).PREVIEW_BASE_URL,
    "http://127.0.0.1:8083"
  );
});

test("loopback hosts follow the controller's rule", () => {
  for (const host of ["localhost", "preview.localhost", "a.b.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
    assert.equal(isLoopbackPreviewHost(host), true, host);
  }
  for (const host of ["previews.test", "localhost.example.com", "notlocalhost", "128.0.0.1", "10.0.0.1", ""]) {
    assert.equal(isLoopbackPreviewHost(host), false, host);
  }
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

test("only the broker's two compose calls get the plan, and the launcher's env is not changed", () => {
  const plan = tunnelBrokerStartPlan({ env: {}, controllerPort, resolveHookSecret: secret });
  const env = { PATH: "/usr/bin", HOME: "/home/dev" };
  const before = { ...env };
  const calls = tunnelBrokerComposeCalls({ plan, env, composeFiles: ["base.yml", "stack.yml"], cwd: "/broker" });

  assert.deepEqual(env, before);
  assert.deepEqual(
    calls.map((call) => call.args.slice(7)),
    [
      ["up", "-d", "postgres", "broker", "rathole", "traefik"],
      ["up", "-d", "rathole-sidecar"],
    ]
  );
  for (const call of calls) {
    assert.equal(call.command, "docker");
    assert.deepEqual(call.args.slice(0, 7), ["compose", "-f", "base.yml", "-f", "stack.yml", "--profile", "ingress"]);
    assert.equal(call.options.cwd, "/broker");
    assert.equal(call.options.env.PATH, "/usr/bin");
    assert.equal(call.options.env.ACL_HOOK_TOKEN, "s3cret");
    assert.equal(call.options.env.PREVIEW_DOMAIN, "preview.localhost");
    // Controller-only settings stay out of the broker's environment.
    assert.equal(Object.hasOwn(call.options.env, "TUNNEL_BROKER_HOOK_SECRET"), false);
    assert.equal(Object.hasOwn(call.options.env, "PREVIEW_BASE_URL"), false);
  }
});

test("a controller counts as this checkout's only when its recorded pid is on the port", () => {
  const listeners = [{ pid: 4321, pgid: 4300 }];
  assert.equal(ownsControllerListener({ recordedPid: 4321, recordedIsController: true, listeners }), true);
  // `cargo run` is the recorded pid; the binary it runs listens in its process group.
  assert.equal(ownsControllerListener({ recordedPid: 4300, recordedIsController: true, listeners }), true);
  // No pid file, a stale pid, or a pid that is not a controller: someone else's.
  assert.equal(ownsControllerListener({ recordedPid: 0, recordedIsController: false, listeners }), false);
  assert.equal(ownsControllerListener({ recordedPid: 999, recordedIsController: true, listeners }), false);
  assert.equal(ownsControllerListener({ recordedPid: 4321, recordedIsController: false, listeners }), false);
  assert.equal(ownsControllerListener({ recordedPid: 4321, recordedIsController: true, listeners: [] }), false);
});

test("a controller this checkout did not start is never restarted", () => {
  // No pid file and a 401 to this checkout's secret: refuse, never kill.
  const foreign = controllerReuseDecision({
    jwksReady: true,
    hookSecret: "s3cret",
    holdsSecret: false,
    ownsListener: false,
    controllerPort: 8788,
  });
  assert.equal(foreign.action, "refuse");
  assert.match(foreign.message, /port 8788.*did not start it.*left running/);
  assert.equal(foreign.message.includes("s3cret"), false);

  // The same holds for a missing origin signing key.
  assert.equal(
    controllerReuseDecision({ jwksReady: false, hookSecret: "", holdsSecret: false, ownsListener: false, controllerPort }).action,
    "refuse"
  );
});

test("this checkout's own controller is restarted when it lacks the key or the secret, else reused", () => {
  const own = { ownsListener: true, controllerPort };
  assert.deepEqual(controllerReuseDecision({ ...own, jwksReady: true, hookSecret: "s3cret", holdsSecret: true }), {
    action: "reuse",
  });
  // No broker hooks this launch (skipped or external broker): the secret is not asked about.
  assert.deepEqual(controllerReuseDecision({ ...own, jwksReady: true, hookSecret: undefined, holdsSecret: false }), {
    action: "reuse",
  });
  assert.deepEqual(controllerReuseDecision({ ...own, jwksReady: true, hookSecret: "s3cret", holdsSecret: false }), {
    action: "restart",
    reason: "without this checkout's tunnel broker hook secret",
  });
  assert.deepEqual(controllerReuseDecision({ ...own, jwksReady: false, hookSecret: "s3cret", holdsSecret: true }), {
    action: "restart",
    reason: "without an origin signing key",
  });
  // Reuse never depends on owning it.
  assert.equal(
    controllerReuseDecision({ jwksReady: true, hookSecret: "s3cret", holdsSecret: true, ownsListener: false, controllerPort }).action,
    "reuse"
  );
});

// The launcher applies these rules; its reuse step must not fall back to a
// machine-wide kill, and the broker's settings must go through the compose calls.
test("the dev launcher uses these rules and never force-kills from its reuse step", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "run-e2e-dev.mjs"), "utf8");
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, name);
    const next = source.indexOf("\nasync function ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };
  const controller = body("startControllerIfNeeded");
  assert.match(controller, /controllerReuseDecision\(/);
  assert.match(controller, /ownsListener: thisCheckoutStartedController\(\)/);
  assert.doesNotMatch(controller, /forceKillControllerProcess|pkill/);
  assert.match(controller, /Object\.assign\(env, brokerControllerEnv\)/);

  const broker = body("startTunnelBrokerIngressIfNeeded");
  assert.match(broker, /tunnelBrokerComposeCalls\(/);
  assert.match(broker, /controllerEnv: plan\.controller/);
  assert.doesNotMatch(broker, /process\.env\[|Object\.assign\(process\.env/);
});
