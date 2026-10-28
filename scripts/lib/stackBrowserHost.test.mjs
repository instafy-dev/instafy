import assert from "node:assert/strict";
import test from "node:test";

import {
  STACK_BROWSER_HOST_IMAGE,
  stackBrowserHostEnabled,
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
