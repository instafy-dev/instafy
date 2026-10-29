import assert from "node:assert/strict";
import test from "node:test";

import {
  STACK_BROWSER_HOST_IMAGE,
  stackBrowserHostEnabled,
  stackBrowserHostReuseWarning,
  withStackBrowserHostControllerEnv,
  withStackBrowserHostProviderEnv,
} from "./stackBrowserHost.mjs";

// A local drive on the default stack restarted the space's machine as a
// browser of its own, whose runs start in Ask: two lookups asked six times.
// Users' spaces host the browser on their own machine and start in routine
// browsing.

test("STACK_BROWSER_HOST=1 launches space machines from the base image and covers every space", () => {
  const env = { STACK_BROWSER_HOST: "1" };
  assert.equal(withStackBrowserHostProviderEnv(env).RUNTIME_AGENT_IMAGE, STACK_BROWSER_HOST_IMAGE);
  assert.equal(withStackBrowserHostControllerEnv(env).HOSTED_BROWSER_HOST, "all");
});

test("the default stack is unchanged", () => {
  for (const value of [undefined, "", "0", "true", "yes"]) {
    const env = value === undefined ? {} : { STACK_BROWSER_HOST: value };
    assert.equal(stackBrowserHostEnabled(env), false, String(value));
    assert.equal(withStackBrowserHostProviderEnv(env).RUNTIME_AGENT_IMAGE, undefined);
    assert.equal(withStackBrowserHostControllerEnv(env).HOSTED_BROWSER_HOST, undefined);
  }
});

test("an operator's own image and policy are kept", () => {
  const env = {
    STACK_BROWSER_HOST: "1",
    RUNTIME_AGENT_IMAGE: "runtime-agent:mine",
    HOSTED_BROWSER_HOST: "projects",
  };
  assert.equal(withStackBrowserHostProviderEnv(env).RUNTIME_AGENT_IMAGE, "runtime-agent:mine");
  assert.equal(withStackBrowserHostControllerEnv(env).HOSTED_BROWSER_HOST, "projects");
});

// `stack:up` reuses a controller and a provider that are already running, and
// their settings were fixed when they started: switching on a running stack
// changed nothing, and the drive saw the old prompts.
test("a controller or provider that is already running is named as keeping its old settings", () => {
  for (const service of ["controller", "provider"]) {
    const warning = stackBrowserHostReuseWarning(service, { STACK_BROWSER_HOST: "1" });
    assert.match(warning, new RegExp(`the ${service} that is already running`));
    assert.match(warning, /STACK_BROWSER_HOST=1 pnpm stack:refresh/);
    assert.equal(stackBrowserHostReuseWarning(service, {}), null);
  }
});
