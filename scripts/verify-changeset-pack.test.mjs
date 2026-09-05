import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assessRegistryState, verifyPackDirectory, verifyRegistry } from "./verify-changeset-pack.mjs";

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

const registryEntry = { name: "@instafy/cli", version: "0.2.0" };
const registryIntegrity = "sha512-reviewed";

function registryClock(context, respond) {
  const clock = { time: 0, requests: [], timeouts: [], sleeps: [] };
  context.mock.method(AbortSignal, "timeout", (milliseconds) => {
    clock.timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  clock.dependencies = {
    now: () => clock.time,
    sleep: async (milliseconds) => {
      clock.sleeps.push(milliseconds);
      clock.time += milliseconds;
    },
    fetchRegistry: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.method, undefined, "registry convergence only issues reads");
      assert.equal(options.body, undefined);
      assert.equal(options.headers, undefined, "public readback receives no credentials");
      clock.requests.push({ url, time: clock.time });
      return respond(url, clock);
    },
  };
  return clock;
}

function registryResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("waits for delayed immutable bytes and latest visibility without republishing", async (context) => {
  const clock = registryClock(context, (url, state) => {
    if (url.endsWith("/dist-tags")) {
      return registryResponse({ latest: state.time >= 102_000 ? "0.2.0" : "0.1.11" });
    }
    return state.time >= 96_000
      ? registryResponse({ dist: { integrity: registryIntegrity } })
      : registryResponse({ error: "Not found" }, 404);
  });
  assert.equal(await verifyRegistry(registryEntry, registryIntegrity, "after", clock.dependencies), true);
  assert.equal(clock.time, 102_000);
  assert.ok(clock.sleeps.length > 10, "covers propagation beyond the former ten-attempt limit");
  assert.ok(clock.timeouts.every((milliseconds) => milliseconds === 15_000));
  assert.ok(clock.requests.every(({ url }) =>
    url === "https://registry.npmjs.org/%40instafy%2Fcli/0.2.0" ||
    url === "https://registry.npmjs.org/-/package/%40instafy%2Fcli/dist-tags"));
});

test("stops exactly at the five-minute deadline and caps every request to the remaining budget", async (context) => {
  const clock = registryClock(context, () => registryResponse({ error: "Not found" }, 404));
  await assert.rejects(
    () => verifyRegistry(registryEntry, registryIntegrity, "after", clock.dependencies),
    /within the readback deadline/u,
  );
  assert.equal(clock.time, 300_000);
  assert.equal(clock.requests.length, 100);
  assert.equal(clock.requests.at(-1).time, 297_000);
  assert.equal(clock.timeouts.at(-1), 3_000);
  for (const [index, request] of clock.requests.entries()) {
    assert.equal(clock.timeouts[index], Math.min(15_000, 300_000 - request.time));
  }
});

test("response-body time is included and an exact match arriving at the deadline is refused", async (context) => {
  const clock = registryClock(context, (url, state) => {
    if (state.time < 297_000) return registryResponse({ error: "Not found" }, 404);
    const tag = url.endsWith("/dist-tags");
    return {
      status: 200,
      ok: true,
      text: async () => {
        state.time += tag ? 1_000 : 2_000;
        return JSON.stringify(tag ? { latest: "0.2.0" } : { dist: { integrity: registryIntegrity } });
      },
    };
  });
  await assert.rejects(
    () => verifyRegistry(registryEntry, registryIntegrity, "after", clock.dependencies),
    /within the readback deadline/u,
  );
  assert.equal(clock.time, 300_000);
  assert.deepEqual(clock.timeouts.slice(-2), [3_000, 1_000]);
  assert.equal(clock.sleeps.length, 99);
});

test("an absent latest tag may converge after publication but never authorizes a prepublish collision", async (context) => {
  const clock = registryClock(context, (url, state) => registryResponse(url.endsWith("/dist-tags")
    ? (state.time >= 30_000 ? { latest: "0.2.0" } : {})
    : { dist: { integrity: registryIntegrity } }));
  assert.equal(await verifyRegistry(registryEntry, registryIntegrity, "after", clock.dependencies), true);
  assert.equal(clock.time, 30_000);

  const before = registryClock(context, (url) => registryResponse(url.endsWith("/dist-tags")
    ? {} : { dist: { integrity: registryIntegrity } }));
  await assert.rejects(
    () => verifyRegistry(registryEntry, registryIntegrity, "before", before.dependencies),
    /npm latest does not point/u,
  );
  assert.equal(before.requests.length, 2);
  assert.deepEqual(before.sleeps, []);
});

test("does not read latest if the immutable response exhausts the budget", async (context) => {
  const clock = registryClock(context, (_url, state) => {
    if (state.time < 297_000) return registryResponse({ error: "Not found" }, 404);
    state.time += 3_000;
    return registryResponse({ dist: { integrity: registryIntegrity } });
  });
  await assert.rejects(
    () => verifyRegistry(registryEntry, registryIntegrity, "after", clock.dependencies),
    /within the readback deadline/u,
  );
  assert.equal(clock.time, 300_000);
  assert.ok(clock.requests.every(({ url }) => !url.endsWith("/dist-tags")));
});

test("before mode keeps its single-read absence and exact collision checks", async (context) => {
  const clock = registryClock(context, () => registryResponse({ error: "Not found" }, 404));
  assert.equal(await verifyRegistry(registryEntry, registryIntegrity, "before", clock.dependencies), false);
  assert.equal(clock.requests.length, 1);
  assert.deepEqual(clock.sleeps, []);

  const existing = registryClock(context, (url) => registryResponse(url.endsWith("/dist-tags")
    ? { latest: "0.2.0" } : { dist: { integrity: registryIntegrity } }));
  assert.equal(await verifyRegistry(registryEntry, registryIntegrity, "before", existing.dependencies), true);
  assert.equal(existing.requests.length, 2);
  assert.deepEqual(existing.sleeps, []);

  const stale = registryClock(context, (url) => registryResponse(url.endsWith("/dist-tags")
    ? { latest: "0.1.11" } : { dist: { integrity: registryIntegrity } }));
  await assert.rejects(
    () => verifyRegistry(registryEntry, registryIntegrity, "before", stale.dependencies),
    /npm latest does not point/u,
  );
  assert.equal(stale.requests.length, 2);
  assert.deepEqual(stale.sleeps, []);
});

for (const mode of ["before", "after"]) {
  test(`${mode} refuses mismatched bytes immediately without a dist-tag read`, async (context) => {
    const clock = registryClock(context, () => registryResponse({ dist: { integrity: "sha512-other" } }));
    await assert.rejects(
      () => verifyRegistry(registryEntry, registryIntegrity, mode, clock.dependencies),
      /different bytes/u,
    );
    assert.equal(clock.requests.length, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  for (const status of [401, 403, 429, 500]) {
    test(`${mode} does not retry registry HTTP ${status}`, async (context) => {
      const clock = registryClock(context, () => registryResponse({ error: "Unavailable" }, status));
      await assert.rejects(
        () => verifyRegistry(registryEntry, registryIntegrity, mode, clock.dependencies),
        new RegExp(`HTTP ${status}`, "u"),
      );
      assert.equal(clock.requests.length, 1);
      assert.deepEqual(clock.sleeps, []);
    });
  }

  for (const body of [{}, { dist: {} }, { dist: { integrity: "" } }, { dist: { integrity: 1 } }]) {
    test(`${mode} refuses a malformed successful integrity response ${JSON.stringify(body)}`, async (context) => {
      const clock = registryClock(context, () => registryResponse(body));
      await assert.rejects(
        () => verifyRegistry(registryEntry, registryIntegrity, mode, clock.dependencies),
        /missing integrity/u,
      );
      assert.equal(clock.requests.length, 1);
      assert.deepEqual(clock.sleeps, []);
    });
  }
}

test("does not retry malformed JSON, malformed dist-tags or transport failures", async (context) => {
  for (const response of [
    () => new Response("{", { status: 200 }),
    () => registryResponse(null),
    () => registryResponse([]),
    () => registryResponse({ latest: null }),
    () => registryResponse({ latest: "" }),
    () => registryResponse({ latest: 1 }),
    () => { throw new Error("read aborted"); },
  ]) {
    const clock = registryClock(context, (url) => url.endsWith("/dist-tags")
      ? response() : registryResponse({ dist: { integrity: registryIntegrity } }));
    await assert.rejects(() => verifyRegistry(registryEntry, registryIntegrity, "after", clock.dependencies));
    assert.equal(clock.requests.length, 2);
    assert.deepEqual(clock.sleeps, []);
  }
});
