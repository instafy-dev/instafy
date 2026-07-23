import { test as teardown } from "@playwright/test";

import globalTeardown from "../global-teardown.js";

teardown.describe.configure({ mode: "serial" });
teardown.setTimeout(180_000);

teardown("stop runtime stack", async () => {
  await globalTeardown();
});
