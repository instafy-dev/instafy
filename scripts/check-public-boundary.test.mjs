import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  findPublicBoundaryViolations,
  loadPublicBoundaryPolicy,
  PUBLIC_BOUNDARY_POLICY_PATH,
} from "./check-public-boundary.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const canonicalGitmodules = readFileSync(
  path.join(repositoryRoot, ".gitmodules"),
);
const fixtureObject = "0123456789abcdef0123456789abcdef01234567";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withFixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "instafy-public-boundary-"));
  try {
    for (const [filePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, filePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }
    return run(root, Object.keys(files));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function utf32(value, littleEndian) {
  const output = Buffer.alloc([...value].length * 4);
  let offset = 0;
  for (const character of value) {
    if (littleEndian) {
      output.writeUInt32LE(character.codePointAt(0), offset);
    } else {
      output.writeUInt32BE(character.codePointAt(0), offset);
    }
    offset += 4;
  }
  return output;
}

function storedZip(entryName, contents) {
  const name = Buffer.from(entryName, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + contents.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, contents, central, name, end]);
}

test("accepts neutral public files and provider-contract product references", () => {
  const productMarker = ["kno", "sh"].join("");
  withFixture(
    {
      "README.md": "Public core documentation.\n",
      "packages/provider-contract/fixture.ts": `export const family = '${productMarker}';\n`,
      ".env.local.example": "TOKEN=replace-me\n",
    },
    (root, paths) => {
      assert.deepEqual(
        findPublicBoundaryViolations({
          root,
          paths,
          policy: {
            approvedEnvironmentTemplates: new Set([".env.local.example"]),
          },
        }),
        [],
      );
    },
  );
});

test("accepts product references only inside the exact hosted-web robot slice prefix", () => {
  const productMarker = ["kno", "sh"].join("");
  const packageMarker = [productMarker, "contract"].join("-");
  withFixture(
    {
      [`packages/frontend/hosted/robot/frontend/${productMarker}Runtime.ts`]: `export const family = '${productMarker}';\n`,
      "packages/frontend/hosted/robot/encoded.txt": Buffer.from(productMarker).toString("base64"),
      "packages/frontend/hosted/robot-evil/probe.ts": `export const family = '${productMarker}';\n`,
      "packages/frontend/hosted/manifest.ts": `export const family = '${productMarker}';\n`,
      "packages/frontend/src/hosted/robot/probe.ts": `export const family = '${productMarker}';\n`,
      "PACKAGES/FRONTEND/HOSTED/ROBOT/probe.ts": `export const family = '${productMarker}';\n`,
      "packages/frontend/hosted/robot/package.ts": `export const name = '${packageMarker}';\n`,
    },
    (root, paths) => {
      const violations = findPublicBoundaryViolations({ root, paths });
      const has = (filePath, rule) =>
        violations.some((finding) => finding.path === filePath && finding.rule === rule);
      assert.ok(!has(`packages/frontend/hosted/robot/frontend/${productMarker}Runtime.ts`, "private-product"));
      assert.ok(!has("packages/frontend/hosted/robot/encoded.txt", "private-product"));
      for (const filePath of [
        "packages/frontend/hosted/robot-evil/probe.ts",
        "packages/frontend/hosted/manifest.ts",
        "packages/frontend/src/hosted/robot/probe.ts",
        "PACKAGES/FRONTEND/HOSTED/ROBOT/probe.ts",
      ]) {
        assert.ok(has(filePath, "private-product"), `expected private-product finding for ${filePath}`);
      }
      assert.ok(
        has("packages/frontend/hosted/robot/package.ts", "private-package"),
        "the private package marker keeps no exception inside the slice",
      );
    },
  );
});

test("a sibling directory whose name extends the slice prefix does not inherit the exception", () => {
  const productMarker = ["kno", "sh"].join("");
  withFixture(
    { "packages/frontend/hosted/robotx/probe.ts": `export const family = '${productMarker}';\n` },
    (root, paths) => {
      assert.ok(
        findPublicBoundaryViolations({ root, paths }).some(
          ({ path: findingPath, rule }) =>
            findingPath === "packages/frontend/hosted/robotx/probe.ts" && rule === "private-product",
        ),
      );
    },
  );
});

test("rejects private paths, live environments, auth material, and product markers", () => {
  const productMarker = ["kno", "sh"].join("");
  withFixture(
    {
      "internal/notes.md": "not public\n",
      "packages/frontend/.env.production": "TOKEN=secret\n",
      ".envrc": "export TOKEN=secret\n",
      "fixtures/.codex/auth.json": "{}\n",
      "packages/frontend/src/product.ts": `export const family = '${productMarker}';\n`,
    },
    (root, paths) => {
      const rules = findPublicBoundaryViolations({ root, paths }).map(
        ({ rule }) => rule,
      );
      assert.ok(rules.includes("private-directory"));
      assert.ok(rules.includes("live-environment-file"));
      assert.ok(
        findPublicBoundaryViolations({ root, paths }).some(
          ({ path: findingPath, rule }) =>
            findingPath === ".envrc" && rule === "live-environment-file",
        ),
      );
      assert.ok(rules.includes("live-auth-file"));
      assert.ok(rules.includes("private-product"));
    },
  );
});

test("only exact reviewed environment template paths are accepted", () => {
  withFixture(
    {
      ".env.local.example": "TOKEN=replace-me\n",
      "arbitrary/.env.production.example": "TOKEN=replace-me\n",
      "PACKAGES/FRONTEND/.ENV.EXAMPLE": "TOKEN=replace-me\n",
    },
    (root, paths) => {
      const violations = findPublicBoundaryViolations({
        root,
        paths,
        policy: {
          approvedEnvironmentTemplates: new Set([".env.local.example"]),
        },
      });
      assert.ok(
        !violations.some(
          ({ path: findingPath }) => findingPath === ".env.local.example",
        ),
      );
      assert.ok(
        violations.some(
          ({ path: findingPath, rule }) =>
            findingPath === "arbitrary/.env.production.example" &&
            rule === "live-environment-file",
        ),
      );
      assert.ok(
        violations.some(
          ({ path: findingPath, rule }) =>
            findingPath === "PACKAGES/FRONTEND/.ENV.EXAMPLE" &&
            rule === "live-environment-file",
        ),
      );
    },
  );
});

test("accepts only the canonical codex gitlink and exact submodule metadata", () => {
  withFixture(
    {
      ".gitmodules": canonicalGitmodules,
    },
    (root) => {
      assert.deepEqual(
        findPublicBoundaryViolations({
          root,
          paths: [".gitmodules", "codex"],
          policy: {
            approvedGitlinks: new Map([["codex", fixtureObject]]),
          },
          indexEntries: [
            {
              mode: "100644",
              object: fixtureObject,
              stage: "0",
              path: ".gitmodules",
            },
            {
              mode: "160000",
              object: fixtureObject,
              stage: "0",
              path: "codex",
            },
          ],
          requireRepositoryMetadata: true,
        }),
        [],
      );
    },
  );
});

test("rejects a codex gitlink object that differs from the reviewed pin", () => {
  withFixture({ ".gitmodules": canonicalGitmodules }, (root) => {
    const violations = findPublicBoundaryViolations({
      root,
      paths: [".gitmodules", "codex"],
      policy: {
        approvedGitlinks: new Map([["codex", fixtureObject]]),
      },
      indexEntries: [
        {
          mode: "100644",
          object: fixtureObject,
          stage: "0",
          path: ".gitmodules",
        },
        {
          mode: "160000",
          object: "f".repeat(40),
          stage: "0",
          path: "codex",
        },
      ],
      requireRepositoryMetadata: true,
    });
    assert.ok(
      violations.some(({ rule }) => rule === "gitlink-object-mismatch"),
    );
  });
});

test("rejects canonical-mode submodule metadata content drift", () => {
  withFixture(
    {
      ".gitmodules": Buffer.concat([
        canonicalGitmodules,
        Buffer.from("# drift\n", "utf8"),
      ]),
    },
    (root) => {
      const violations = findPublicBoundaryViolations({
        root,
        paths: [".gitmodules", "codex"],
        policy: {
          approvedGitlinks: new Map([["codex", fixtureObject]]),
        },
        indexEntries: [
          {
            mode: "100644",
            object: fixtureObject,
            stage: "0",
            path: ".gitmodules",
          },
          {
            mode: "160000",
            object: fixtureObject,
            stage: "0",
            path: "codex",
          },
        ],
        requireRepositoryMetadata: true,
      });
      assert.ok(
        violations.some(
          ({ rule }) => rule === "gitmodules-content-mismatch",
        ),
      );
    },
  );
});

test("rejects submodule metadata drift, unknown gitlinks, and unsafe index modes", () => {
  withFixture(
    {
      ".gitmodules": Buffer.concat([
        canonicalGitmodules,
        Buffer.from("# drift\n", "utf8"),
      ]),
      "linked.txt": "target\n",
    },
    (root) => {
      const rules = new Set(
        findPublicBoundaryViolations({
          root,
          paths: [".gitmodules", "codex", "other-module", "linked.txt"],
          policy: {
            approvedGitlinks: new Map([["codex", fixtureObject]]),
          },
          indexEntries: [
            {
              mode: "100755",
              object: fixtureObject,
              stage: "0",
              path: ".gitmodules",
            },
            {
              mode: "160000",
              object: fixtureObject,
              stage: "0",
              path: "other-module",
            },
            {
              mode: "120000",
              object: fixtureObject,
              stage: "0",
              path: "linked.txt",
            },
          ],
          requireRepositoryMetadata: true,
        }).map(({ rule }) => rule),
      );
      assert.ok(rules.has("unexpected-gitlink"));
      assert.ok(rules.has("symbolic-link"));
      assert.ok(rules.has("missing-approved-gitlink"));
      assert.ok(rules.has("gitmodules-index-mode"));
    },
  );
});

test("rejects marker-bearing repository paths", () => {
  const host = ["internal", "instafy", "dev"].join(".");
  const network = [10, 42, 1, 9].join(".");
  const tokenPrefix = ["gh", "p_"].join("");
  withFixture(
    {
      [`docs/${host}.txt`]: "neutral\n",
      [`docs/${network}.txt`]: "neutral\n",
      [`docs/${tokenPrefix}fixture.txt`]: "neutral\n",
      [["docs", "Users", "example", "note.txt"].join("/")]: "neutral\n",
    },
    (root, paths) => {
      const rules = new Set(
        findPublicBoundaryViolations({ root, paths }).map(({ rule }) => rule),
      );
      assert.ok(rules.has("private-host"));
      assert.ok(rules.has("private-network"));
      assert.ok(rules.has("github-token-prefix"));
      assert.ok(rules.has("absolute-personal-path"));
    },
  );
});

test("rejects Git LFS pointers and LFS attributes as external byte indirection", () => {
  const pointerHeader = [
    "version https://git-",
    "lfs.github.com/spec/v1",
  ].join("");
  withFixture(
    {
      "payload.data": `${pointerHeader}\noid sha256:${"0".repeat(64)}\nsize 1\n`,
      ".gitattributes": "*.data filter=lfs diff=lfs merge=lfs\n",
    },
    (root, paths) => {
      const rules = new Set(
        findPublicBoundaryViolations({ root, paths }).map(({ rule }) => rule),
      );
      assert.ok(rules.has("git-lfs-pointer"));
      assert.ok(rules.has("git-lfs-attribute"));
    },
  );
});

test("rejects high-risk content markers without publishing their literal values here", () => {
  const tokenPrefix = ["gh", "p_"].join("");
  const host = ["internal", "instafy", "dev"].join(".");
  const browserServiceRole = ["VITE", "SUPABASE", "SERVICE", "ROLE", "KEY"].join(
    "_",
  );
  withFixture(
    {
      "fixture.txt": [
        `${tokenPrefix}example`,
        `https://${host}`,
        `/${["Users", "example", "repo"].join("/")}`,
        `${browserServiceRole}=value`,
      ].join("\n"),
    },
    (root, paths) => {
      const rules = new Set(
        findPublicBoundaryViolations({ root, paths }).map(({ rule }) => rule),
      );
      assert.ok(rules.has("github-token-prefix"));
      assert.ok(rules.has("private-host"));
      assert.ok(rules.has("absolute-personal-path"));
      assert.ok(rules.has("browser-exposed-service-role"));
    },
  );
});

test("rejects common encodings of the private product outside its public contract", () => {
  const productMarker = ["kno", "sh"].join("");
  const base64Marker = Buffer.from(productMarker).toString("base64");
  const hexMarker = Buffer.from(productMarker).toString("hex");
  const percentMarker = [...Buffer.from(productMarker)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  const nestedMarker = Buffer.from(base64Marker).toString("base64");
  withFixture(
    {
      "base64.txt": base64Marker,
      "hex.txt": hexMarker,
      "percent.txt": percentMarker,
      "nested.txt": nestedMarker,
      "packages/provider-contract/encoded.txt": base64Marker,
      "PACKAGES/PROVIDER-CONTRACT/probe.svg": productMarker,
    },
    (root, paths) => {
      const violations = findPublicBoundaryViolations({ root, paths });
      for (const filePath of [
        "base64.txt",
        "hex.txt",
        "percent.txt",
        "nested.txt",
      ]) {
        assert.ok(
          violations.some(
            ({ path: findingPath, rule }) =>
              findingPath === filePath && rule === "private-product",
          ),
          `expected encoded private-product finding for ${filePath}`,
        );
      }
      assert.ok(
        !violations.some(
          ({ path: findingPath, rule }) =>
            findingPath === "packages/provider-contract/encoded.txt" &&
            rule === "private-product",
        ),
      );
      assert.ok(
        violations.some(
          ({ path: findingPath, rule }) =>
            findingPath === "PACKAGES/PROVIDER-CONTRACT/probe.svg" &&
            rule === "private-product",
        ),
      );
    },
  );
});

test("finds markers in UTF-16 and UTF-32 little- and big-endian bytes", () => {
  const host = ["internal", "instafy", "dev"].join(".");
  const utf16Little = Buffer.from(host, "utf16le");
  const utf16Big = Buffer.from(utf16Little);
  utf16Big.swap16();
  withFixture(
    {
      "utf16-le.data": utf16Little,
      "utf16-be.data": utf16Big,
      "utf32-le.data": utf32(host, true),
      "utf32-be.data": utf32(host, false),
    },
    (root, paths) => {
      const violations = findPublicBoundaryViolations({ root, paths });
      for (const filePath of paths) {
        assert.ok(
          violations.some(
            ({ path: findingPath, rule }) =>
              findingPath === filePath && rule === "private-host",
          ),
          `expected wide marker finding for ${filePath}`,
        );
      }
    },
  );
});

test("invalid UTF-8 and every unknown binary or archive fail closed", () => {
  const host = ["internal", "instafy", "dev"].join(".");
  const gzip = gzipSync(Buffer.from(`https://${host}\n`));
  const zip = storedZip("payload.txt", Buffer.from(`https://${host}\n`));
  withFixture(
    {
      "invalid-utf8.txt": Buffer.from([0xc3, 0x28]),
      "payload.gz": gzip,
      "payload.zip": zip,
      "unknown.bin": Buffer.from([0, 1, 2, 255]),
    },
    (root, paths) => {
      const violations = findPublicBoundaryViolations({ root, paths });
      for (const filePath of paths) {
        assert.ok(
          violations.some(
            ({ path: findingPath, rule }) =>
              findingPath === filePath && rule === "unapproved-binary",
          ),
          `expected binary rejection for ${filePath}`,
        );
      }
    },
  );
});

test("the canonical policy approves all 47 reviewed binary assets", () => {
  const policy = loadPublicBoundaryPolicy(PUBLIC_BOUNDARY_POLICY_PATH);
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.approvedEnvironmentTemplates.size, 16);
  assert.deepEqual(
    [...policy.approvedGitlinks],
    [["codex", "e834d276eeafce2b86a86ebe926a77013b734a79"]],
  );
  assert.equal(policy.binaryAssetCount, 47);
  assert.equal(policy.binarySha256.size, 47);
  assert.deepEqual(
    findPublicBoundaryViolations({
      root: repositoryRoot,
      paths: [...policy.binarySha256.keys()],
      policy,
      requireCompletePolicy: true,
    }),
    [],
  );
});

test("an approved binary path fails when its bytes drift", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  withFixture({ "asset.png": bytes }, (root, paths) => {
    const violations = findPublicBoundaryViolations({
      root,
      paths,
      policy: {
        binarySha256: new Map([["asset.png", sha256(Buffer.from("different"))]]),
      },
      requireCompletePolicy: true,
    });
    assert.ok(
      violations.some(({ rule }) => rule === "binary-digest-mismatch"),
    );
  });
});
