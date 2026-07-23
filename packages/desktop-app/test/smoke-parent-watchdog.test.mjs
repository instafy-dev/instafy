import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  resolveSmokeParentWatchdogConfig,
  startSmokeParentWatchdog,
} from "../dist/smokeParentWatchdog.js";

const MARKER = "11111111-1111-4111-8111-111111111111";
const RECOVERY_ROOT = path.resolve("/tmp/instafy-smoke-watchdog-test");
const PROFILE_PATH = path.join(
  RECOVERY_ROOT,
  "profiles",
  MARKER,
);

test("smoke watchdog is disabled unless every recovery value is supplied", () => {
  assert.equal(
    resolveSmokeParentWatchdogConfig(undefined, undefined, null, undefined, null),
    null,
  );
  assert.throws(
    () =>
      resolveSmokeParentWatchdogConfig(
        "12345",
        MARKER,
        MARKER,
        RECOVERY_ROOT,
        path.join(RECOVERY_ROOT, "wrong-profile"),
      ),
    /profile path does not match/i,
  );
});

test("smoke watchdog accepts only a matching parent, marker, and profile", () => {
  assert.deepEqual(
    resolveSmokeParentWatchdogConfig(
      "12345",
      MARKER,
      MARKER,
      RECOVERY_ROOT,
      PROFILE_PATH,
    ),
    { parentPid: 12345, recoveryMarker: MARKER },
  );
  assert.throws(
    () =>
      resolveSmokeParentWatchdogConfig(
        "12345",
        MARKER,
        "22222222-2222-4222-8222-222222222222",
        RECOVERY_ROOT,
        PROFILE_PATH,
      ),
    /invalid/i,
  );
});

test("smoke watchdog closes exactly once after its parent disappears", async () => {
  let alive = true;
  let parentLostCount = 0;
  const stop = startSmokeParentWatchdog(
    { parentPid: 12345, recoveryMarker: MARKER },
    {
      intervalMs: 5,
      isProcessAlive: () => alive,
      onParentLost: () => {
        parentLostCount += 1;
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(parentLostCount, 0);
  alive = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(parentLostCount, 1);
  stop();
  stop();
});
