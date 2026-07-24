import assert from "node:assert/strict";
import test from "node:test";

import { modulePathToImportUrl } from "../scripts/module-import-url.mjs";

test("converts an absolute Windows module path to a file URL", () => {
  assert.equal(
    modulePathToImportUrl(
      String.raw`D:\a\instafy\instafy\packages\desktop-app\dist\bundledRuntimeAgent.js`,
      { windows: true },
    ),
    "file:///D:/a/instafy/instafy/packages/desktop-app/dist/bundledRuntimeAgent.js",
  );
});

test("encodes a POSIX module path before dynamic import", () => {
  assert.equal(
    modulePathToImportUrl("/tmp/Instafy Studio/dist/bundledRuntimeAgent.js", {
      windows: false,
    }),
    "file:///tmp/Instafy%20Studio/dist/bundledRuntimeAgent.js",
  );
});
