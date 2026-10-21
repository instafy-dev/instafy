// Bundle the bound-sites binder (packages/instafy-bind) into dist/bind, so `instafy bind ...` works from the
// published CLI without a second package. The binder is zero-dependency Node ESM, so a plain copy is enough.
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(cliRoot, "..", "instafy-bind");
const target = path.join(cliRoot, "dist", "bind");

if (!fs.existsSync(path.join(source, "bin", "instafy-bind.mjs"))) {
  console.error(`copy-bind: ${source} has no bin/instafy-bind.mjs`);
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
for (const dir of ["bin", "src", "client"]) {
  fs.cpSync(path.join(source, dir), path.join(target, dir), { recursive: true });
}
fs.copyFileSync(path.join(source, "LICENSE"), path.join(target, "LICENSE"));
console.log(`copy-bind: ${path.relative(cliRoot, target)} <- ${path.relative(cliRoot, source)}`);
