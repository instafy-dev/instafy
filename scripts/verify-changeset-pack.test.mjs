import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assessRegistryState, verifyPackDirectory } from "./verify-changeset-pack.mjs";

const temporaryDirectories = [];

test.afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createCliPack({ publishConfig = { access: "public" } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-changeset-pack-"));
  temporaryDirectories.push(root);
  const source = path.join(root, "source");
  const pack = path.join(root, "pack");
  const packages = path.join(pack, "packages");
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.mkdir(path.join(source, "dist"), { recursive: true });
  await fs.mkdir(packages, { recursive: true });
  await fs.writeFile(path.join(source, "LICENSE"), "license\n");
  await fs.writeFile(path.join(source, "README.md"), "readme\n");
  await fs.writeFile(path.join(source, "bin", "instafy.js"), "#!/usr/bin/env node\n");
  await fs.writeFile(path.join(source, "dist", "cli.js"), "export {};\n");
  await fs.writeFile(
    path.join(source, "package.json"),
    `${JSON.stringify(
      {
        name: "@instafy/cli",
        version: "0.2.0",
        private: false,
        type: "module",
        bin: { instafy: "bin/instafy.js" },
        files: ["bin", "dist/cli.js", "LICENSE", "README.md"],
        publishConfig,
        repository: {
          type: "git",
          url: "git+https://github.com/instafy-dev/instafy.git",
          directory: "packages/instafy-cli",
        },
      },
      null,
      2,
    )}\n`,
  );
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packages], {
    cwd: source,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarballPath = path.join(packages, "instafy-cli-0.2.0.tgz");
  const integrity = `sha256-${createHash("sha256").update(await fs.readFile(tarballPath)).digest("base64")}`;
  await fs.writeFile(
    path.join(pack, "publish-plan.json"),
    `${JSON.stringify(
      {
        version: 1,
        plan: [
          [
            {
              kind: "publish",
              name: "@instafy/cli",
              version: "0.2.0",
              access: "public",
              tag: "latest",
              tarball: { path: "packages/instafy-cli-0.2.0.tgz", integrity },
            },
          ],
        ],
      },
      null,
      2,
    )}\n`,
  );
  return pack;
}

test("accepts an exact allowlisted Changesets pack and returns both hashes", async () => {
  const pack = await createCliPack();
  const receipt = await verifyPackDirectory(pack, {
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(receipt.schemaVersion, "instafy-npm-release-receipt-v1");
  assert.equal(receipt.packages.length, 1);
  assert.equal(receipt.packages[0].name, "@instafy/cli");
  assert.match(receipt.packages[0].sha256, /^sha256-/u);
  assert.match(receipt.packages[0].sha512, /^sha512-/u);
});

test("rejects a modified tarball integrity", async () => {
  const pack = await createCliPack();
  const planPath = path.join(pack, "publish-plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  plan.plan[0][0].tarball.integrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await fs.writeFile(planPath, `${JSON.stringify(plan)}\n`);
  await assert.rejects(() => verifyPackDirectory(pack), /SHA-256 integrity mismatch/u);
});

test("rejects extra files outside the exact publish plan", async () => {
  const pack = await createCliPack();
  await fs.writeFile(path.join(pack, "unexpected.txt"), "not part of the release\n");
  await assert.rejects(() => verifyPackDirectory(pack), /missing or unexpected files/u);
});

test("rejects symlinks before interpreting pack contents", async () => {
  const pack = await createCliPack();
  await fs.symlink("publish-plan.json", path.join(pack, "linked-plan.json"));
  await assert.rejects(() => verifyPackDirectory(pack), /pack contains symlink/u);
});

test("rejects packages outside the reviewed public allowlist", async () => {
  const pack = await createCliPack();
  const planPath = path.join(pack, "publish-plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  plan.plan[0][0].name = "@instafy/unreviewed";
  await fs.writeFile(planPath, `${JSON.stringify(plan)}\n`);
  await assert.rejects(() => verifyPackDirectory(pack), /unrecognized publishable package/u);
});

test("rejects package-level registry overrides", async () => {
  const pack = await createCliPack({
    publishConfig: { access: "public", registry: "https://registry.example.invalid/" },
  });
  await assert.rejects(() => verifyPackDirectory(pack), /tarball manifest is not public/u);
});

test("requires both exact registry bytes and the planned latest dist-tag", () => {
  const entry = { name: "@instafy/cli", version: "0.2.0" };
  const sha512 = "sha512-reviewed";
  assert.deepEqual(
    assessRegistryState(entry, sha512, { integrity: null, latest: "0.1.11" }, "before"),
    { done: true, alreadyPublished: false },
  );
  assert.deepEqual(
    assessRegistryState(
      entry,
      sha512,
      { integrity: sha512, latest: "0.2.0" },
      "after",
    ),
    { done: true, alreadyPublished: true },
  );
  assert.deepEqual(
    assessRegistryState(
      entry,
      sha512,
      { integrity: sha512, latest: "0.1.11" },
      "after",
    ),
    { done: false, alreadyPublished: true },
  );
  assert.throws(
    () =>
      assessRegistryState(
        entry,
        sha512,
        { integrity: sha512, latest: "0.1.11" },
        "before",
      ),
    /npm latest does not point/u,
  );
  assert.throws(
    () =>
      assessRegistryState(
        entry,
        sha512,
        { integrity: "sha512-other", latest: "0.2.0" },
        "after",
      ),
    /different bytes/u,
  );
});
