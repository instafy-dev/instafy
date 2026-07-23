import { test as setup } from "@playwright/test";

import globalSetup from "../global-setup.js";

setup.describe.configure({ mode: "serial" });
// Cold-start runs may need to compile `packages/runtime-agent` (and Codex) before the
// runtime stack can be exercised. That can take several minutes on a fresh checkout.
setup.setTimeout(900_000);

setup("start runtime stack", async () => {
  await globalSetup();
});
