// Loaded before every test file (package.json "test": node --import): each test run gets its own lookup-health
// file (src/lookup.mjs), so a breaker a test opened (a refused 127.0.0.1:9) never leaks into the next run or into
// the developer's real ~/.cache/instafy/lookup-health.json. Handlers the tests spawn inherit it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.INSTAFY_LOOKUP_STATE_KEEP) {
  process.env.INSTAFY_LOOKUP_STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bind-lookup-")), "lookup-health.json");
}
