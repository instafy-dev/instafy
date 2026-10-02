import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const productionDockerfiles = [
  "packages/runtime-controller/Dockerfile",
  "packages/tunnel-broker/Dockerfile",
  "docker/runtime/Dockerfile",
  "docker/proxy/Dockerfile",
  "docker/provider-service/Dockerfile",
  "docker/git-edge/Dockerfile",
  "docker/git-shard/Dockerfile",
  "docker/origin-gateway/Dockerfile",
  "docker/speech-host/Dockerfile",
];

// This combined image is used by local development rather than publication,
// but pin it too so the repository has no special unpinned Dockerfile escape.
const localDockerfiles = ["docker/git-services-dev/Dockerfile"];
const pinnedImage = /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/u;
const checksum = /^[0-9a-f]{64}$/u;

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function argumentDefaults(source) {
  const defaults = new Map();
  for (const match of source.matchAll(/^ARG ([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/gmu)) {
    defaults.set(match[1], match[2]);
  }
  return defaults;
}

function resolveBuildArguments(reference, defaults, relativePath) {
  let resolved = reference;
  for (let pass = 0; pass < 20 && resolved.includes("${"); pass += 1) {
    resolved = resolved.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name) => {
      assert.ok(
        defaults.has(name),
        `${relativePath} FROM uses ${name} without a committed default`,
      );
      return defaults.get(name);
    });
  }
  assert.doesNotMatch(
    resolved,
    /\$\{/u,
    `${relativePath} FROM contains unresolved build arguments`,
  );
  return resolved;
}

// External image references only: a FROM naming a stage defined earlier in the
// same Dockerfile builds on that stage and pulls nothing.
function dockerfileFromReferences(source) {
  const stages = new Set();
  const references = [];
  for (const match of source.matchAll(/^FROM(?: --platform=\S+)? (\S+)(?: AS (\S+))?/gmu)) {
    if (!stages.has(match[1])) references.push(match[1]);
    if (match[2]) stages.add(match[2]);
  }
  return references;
}

function dockerfileStage(source, stageName) {
  const stages = [...source.matchAll(/^FROM(?: --platform=\S+)? \S+ AS (\S+)$/gmu)];
  const index = stages.findIndex((match) => match[1] === stageName);
  assert.notEqual(index, -1, `Dockerfile is missing stage ${stageName}`);
  const start = stages[index].index;
  const end = stages[index + 1]?.index ?? source.length;
  return source.slice(start, end);
}

function assertPinnedChecksumArgument(source, name, expected, relativePath) {
  const actual = argumentDefaults(source).get(name);
  assert.match(
    actual ?? "",
    checksum,
    `${relativePath} must give ${name} a full SHA-256 default`,
  );
  assert.equal(actual, expected, `${relativePath} has an unexpected ${name}`);
}

// One workflow step, from its name line to the next step (of any form) or job.
function workflowStep(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `workflow is missing step ${name}`);
  const next = source.slice(start + 1).search(/\n(?:      - |  [\w-]+:\n)/u);
  return next < 0 ? source.slice(start) : source.slice(start, start + next + 2);
}

// The runtime image has two publishers: the amd64 production release and the
// best-effort arm64 lane. Both build, scan and publish the same way.
const runtimePublishers = [
  { file: "publish-runtime-agent.yml", job: "build-scan-push", next: "assemble-release-manifest",
    architecture: "amd64", runner: "ubuntu-24.04", other: "arm64" },
  { file: "publish-runtime-agent-multiarch.yml", job: "build-scan-push-arm64", next: "assemble-multiarch",
    architecture: "arm64", runner: "ubuntu-24.04-arm", other: "amd64" },
];

function assertOrdered(source, label, ...needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `${label} is missing ordered input: ${needle}`);
    cursor = next;
  }
}

test("every repository Dockerfile pins external base images by digest", () => {
  for (const relativePath of [...productionDockerfiles, ...localDockerfiles]) {
    const source = read(relativePath);
    const syntax = source.match(/^# syntax=(\S+)$/mu);
    if (syntax) {
      assert.match(
        syntax[1],
        pinnedImage,
        `${relativePath} must pin its Dockerfile frontend by digest`,
      );
    }
    const defaults = argumentDefaults(source);
    const references = dockerfileFromReferences(source);
    assert.ok(references.length > 0, `${relativePath} must contain a FROM instruction`);

    for (const reference of references) {
      const resolved = resolveBuildArguments(reference, defaults, relativePath);
      if (resolved === "scratch") continue;
      assert.match(
        resolved,
        pinnedImage,
        `${relativePath} must pin ${resolved} as tag@sha256:<64 hex>`,
      );
    }
  }
});

test("runtime image inputs reject the vulnerable Chromium and Go crypto baselines", () => {
  const runtimePath = "docker/runtime/Dockerfile";
  const runtimeSource = read(runtimePath);
  const runtimeDefaults = argumentDefaults(runtimeSource);

  assert.equal(
    runtimeDefaults.get("RUNTIME_BASE"),
    "debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132",
  );
  assert.equal(
    runtimeDefaults.get("CHROMIUM_MIN_VERSION"),
    "152.0.7977.82-1~deb13u1",
  );
  assert.match(
    dockerfileStage(runtimeSource, "runtime"),
    /^ARG CHROMIUM_MIN_VERSION$/mu,
  );
  assert.match(
    dockerfileStage(runtimeSource, "runtime"),
    /test -n "\$\{CHROMIUM_MIN_VERSION\}"/u,
  );
  assert.match(
    dockerfileStage(runtimeSource, "runtime"),
    /dpkg --compare-versions[\s\S]*chromium\)" ge "\$\{CHROMIUM_MIN_VERSION\}"/u,
  );

  assert.match(
    read("packages/browser-webrtc-sender/go.mod"),
    /^\s*golang\.org\/x\/crypto v0\.55\.0 \/\/ indirect$/mu,
  );
});

test("base runtime explicitly refreshes inherited gzip, PCRE2 and SQLite and rejects obsolete versions", () => {
  const source = read("docker/runtime/Dockerfile");
  const defaults = argumentDefaults(source);
  const runtime = dockerfileStage(source, "runtime");
  const packages = [
    ["gzip", "GZIP_MIN_VERSION", "1.13-1+deb13u1"],
    ["libpcre2-8-0", "PCRE2_MIN_VERSION", "10.46-1~deb13u2"],
    ["libsqlite3-0", "SQLITE3_MIN_VERSION", "3.46.1-7+deb13u2"],
  ];
  for (const [name, argument, minimum] of packages) {
    assert.equal(defaults.get(argument), minimum);
    assert.ok(runtime.includes(`ARG ${argument}\n`));
    assertOrdered(runtime, name, "apt-get update", "apt-get install -y --no-install-recommends",
      `      ${name} \\\n`, `test -n "\${${argument}}"`,
      `dpkg --compare-versions "$(dpkg-query -W -f='\${Version}' ${name})" ge "\${${argument}}"`,
      "rm -rf /var/lib/apt/lists/*");
  }
});

test("every published Debian service refreshes inherited packages at its release's security floors", () => {
  const bookwormPackages = [
    ["libpcre2-8-0", "PCRE2_MIN_VERSION", "10.42-1+deb12u1"],
  ];
  const trixiePackages = [
    ["gzip", "GZIP_MIN_VERSION", "1.13-1+deb13u1"],
    ["libpcre2-8-0", "PCRE2_MIN_VERSION", "10.46-1~deb13u2"],
    ["libsqlite3-0", "SQLITE3_MIN_VERSION", "3.46.1-7+deb13u2"],
    ["perl-base", "PERL_BASE_MIN_VERSION", "5.40.1-6+deb13u1"],
  ];
  const expected = new Map([
    ["packages/runtime-controller/Dockerfile", ["bookworm", bookwormPackages]],
    ["packages/tunnel-broker/Dockerfile", ["bookworm", bookwormPackages]],
    ["docker/proxy/Dockerfile", ["bookworm", bookwormPackages]],
    ["docker/git-edge/Dockerfile", ["trixie", trixiePackages]],
    ["docker/git-shard/Dockerfile", ["trixie", trixiePackages]],
    ["docker/origin-gateway/Dockerfile", ["trixie", trixiePackages]],
  ]);
  const publishedDockerfiles = [...read(".github/workflows/publish-production-services.yml")
    .matchAll(/^\s+dockerfile: (\S+)$/gmu)].map((match) => match[1]);
  const debianDockerfiles = publishedDockerfiles.filter((relativePath) => {
    const source = read(relativePath);
    const reference = dockerfileFromReferences(source).at(-1);
    return resolveBuildArguments(reference, argumentDefaults(source), relativePath)
      .startsWith("debian:");
  });
  assert.deepEqual(debianDockerfiles.sort(), [...expected.keys()].sort(),
    "a new published Debian service needs reviewed security-package coverage");

  // Speech host is a production image, but not a cell in the service publisher.
  expected.set("docker/speech-host/Dockerfile", ["bookworm", bookwormPackages]);
  for (const [relativePath, [release, packages]] of expected) {
    const source = read(relativePath);
    const runtime = relativePath === "docker/speech-host/Dockerfile"
      ? source : dockerfileStage(source, "runtime");
    const defaults = argumentDefaults(source);
    const reference = resolveBuildArguments(dockerfileFromReferences(runtime)[0], defaults, relativePath);
    assert.ok(reference.includes(`${release}-slim@sha256:`),
      `${relativePath} security floors must match its final base distribution`);
    for (const [name, argument, minimum] of packages) {
      assert.equal(defaults.get(argument), minimum, `${relativePath}: ${argument}`);
      assert.ok(runtime.includes(`ARG ${argument}=${minimum}\n`),
        `${relativePath}: security argument must be in the final stage`);
      assertOrdered(runtime, `${relativePath}: ${name}`,
        "apt-get update", "apt-get install -y --no-install-recommends",
        `      ${name} \\\n`, `test -n "\${${argument}}"`,
        `dpkg --compare-versions "$(dpkg-query -W -f='\${Version}' ${name})" ge "\${${argument}}"`,
        "rm -rf /var/lib/apt/lists/*");
    }
  }
});

test("affected runtime images refresh every util-linux security binary", () => {
  const expectedStages = new Map([
    ["docker/git-edge/Dockerfile", ["runtime"]],
    ["docker/git-shard/Dockerfile", ["runtime"]],
    ["docker/origin-gateway/Dockerfile", ["runtime"]],
    ["docker/runtime/Dockerfile", ["runtime", "runtime-webdev"]],
    ["docker/git-services-dev/Dockerfile", ["runtime"]],
  ]);
  const securityPackages = ["bsdutils", "login", "mount", "util-linux"];

  for (const [relativePath, stageNames] of expectedStages) {
    const source = read(relativePath);
    for (const stageName of stageNames) {
      const installLines = dockerfileStage(source, stageName)
        .split("\n")
        .map((line) => line.trim());
      for (const packageName of securityPackages) {
        const actualCount = installLines.filter(
          (line) => line === packageName || line === `${packageName} \\`,
        ).length;
        assert.equal(
          actualCount,
          1,
          `${relativePath} stage ${stageName} must install ${packageName} exactly once`,
        );
      }
    }
  }
});

test("provider service pins the complete Docker CLI toolchain", () => {
  const relativePath = "docker/provider-service/Dockerfile";
  const source = read(relativePath);

  assert.match(
    source,
    /^FROM alpine:3\.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40$/mu,
  );
  assert.equal(argumentDefaults(source).get("OPENSSL_VERSION"), "3.5.9-r0");
  assert.equal(argumentDefaults(source).get("DOCKER_CLI_VERSION"), "29.5.2-r0");
  assert.equal(argumentDefaults(source).get("DOCKER_BUILDX_VERSION"), "0.30.1-r6");
  assert.equal(argumentDefaults(source).get("DOCKER_COMPOSE_VERSION"), "2.40.3-r6");
  assertOrdered(
    source,
    relativePath,
    '"libcrypto3=${OPENSSL_VERSION}"',
    '"libssl3=${OPENSSL_VERSION}"',
    '"docker-cli=${DOCKER_CLI_VERSION}"',
    '"docker-cli-buildx=${DOCKER_BUILDX_VERSION}"',
    '"docker-cli-compose=${DOCKER_COMPOSE_VERSION}"',
  );
  assert.doesNotMatch(source, /^FROM docker:/mu);
});

test("runtime downloads verify architecture-bound checksums before extraction", () => {
  const relativePath = "docker/runtime/Dockerfile";
  const source = read(relativePath);
  const ratholeAmd64 =
    "3e7d0d0f365120cd3cd351d147d1a12ee960c8068b464d4dd533a3821873b80e";
  const ratholeArm64 =
    "fa4a6fc63d86f8f1faa7c103a845e4715ce79a048455c0eec897b27237576564";
  const uBlock =
    "d5811c79278f27001ae0be090e824577c505cc2b4151997e252462df9f11ba36";

  assertPinnedChecksumArgument(
    source,
    "RATHOLE_SHA256_AMD64",
    ratholeAmd64,
    relativePath,
  );
  assertPinnedChecksumArgument(
    source,
    "RATHOLE_SHA256_ARM64",
    ratholeArm64,
    relativePath,
  );
  assertPinnedChecksumArgument(
    source,
    "UBOLITE_SHA256_AMD64",
    uBlock,
    relativePath,
  );
  assertPinnedChecksumArgument(
    source,
    "UBOLITE_SHA256_ARM64",
    uBlock,
    relativePath,
  );
  assert.equal(
    [...source.matchAll(/sha256sum --check --status/gu)].length,
    11,
    "runtime and webdev downloads must each verify their archive",
  );
  assert.equal(
    [...source.matchAll(/curl --proto '=https' --tlsv1\.2/gu)].length,
    11,
    "runtime release downloads must enforce HTTPS and TLS 1.2+",
  );

  // pnpm 11.24.0 vendors node-tar 7.5.22. Earlier images carried
  // vulnerable 7.5.19/7.5.20 copies (CVE-2026-73566).
  assert.equal(argumentDefaults(source).get("PNPM_VERSION"), "11.24.0");

  // npm's vendored vulnerable packages must stay pinned by exact version and
  // tarball checksum, and both runtime flavors must verify every replaced
  // module's version after extraction.
  assert.equal(argumentDefaults(source).get("NPM_TAR_VERSION"), "7.5.22");
  assertPinnedChecksumArgument(
    source,
    "NPM_TAR_SHA256",
    "b792c2d1c7fc770910522ca1ffc29eee02ee38de4fa3a01e7832eb705879c6c6",
    relativePath,
  );
  assert.equal(
    argumentDefaults(source).get("BRACE_EXPANSION_VERSION"),
    "5.0.12",
  );
  assertPinnedChecksumArgument(
    source,
    "BRACE_EXPANSION_SHA256",
    "ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4",
    relativePath,
  );
  assert.equal(argumentDefaults(source).get("IP_ADDRESS_VERSION"), "10.3.1");
  assertPinnedChecksumArgument(
    source,
    "IP_ADDRESS_SHA256",
    "ad1790063beea11a312c801df30d58e147de762f4f77787552376eb7424623e5",
    relativePath,
  );
  // npm vendors undici 6.27.0 and pnpm's dist vendors 6.28.0 (CVE-2026-19534).
  assert.equal(argumentDefaults(source).get("UNDICI_VERSION"), "6.28.1");
  assertPinnedChecksumArgument(
    source,
    "UNDICI_SHA256",
    "e18191aac9c0ff43dac7fe9b10b7041a22d07addb7b66a6e8ac14a52a5b69b74",
    relativePath,
  );
  // Patch EVERY npm installation in the image, not one hardcoded prefix: the
  // webdev (Playwright) base ships a second npm at /usr/lib/node_modules that
  // the /usr/local-only patch missed (run 30750744597, webdev cells only).
  assert.equal(
    [...source.matchAll(
      /for nt_dir in \$\(find \/usr -type d -path '\*\/node_modules\/npm\/node_modules\/tar'/gu,
    )].length,
    2,
    "both runtime flavors must patch every npm root's tar",
  );
  assert.doesNotMatch(
    source,
    /tar -xzf \/tmp\/npm-tar\.tgz -C \/usr\/local/u,
    "the patch must not target a single hardcoded npm prefix",
  );
  assert.equal(
    [...source.matchAll(
      /for be_dir in \$\(find \/usr -type d -path '\*\/node_modules\/npm\/node_modules\/brace-expansion'/gu,
    )].length,
    2,
    "both runtime flavors must patch every npm root's brace-expansion",
  );
  assert.doesNotMatch(
    source,
    /tar -xzf \/tmp\/brace-expansion\.tgz -C \/usr\/local/u,
    "the patch must not target a single hardcoded npm prefix",
  );
  assert.equal(
    [...source.matchAll(
      /for ia_dir in \$\(find \/usr -type d -path '\*\/node_modules\/npm\/node_modules\/ip-address'/gu,
    )].length,
    2,
    "both runtime flavors must patch every npm root's ip-address",
  );
  assert.doesNotMatch(
    source,
    /tar -xzf \/tmp\/ip-address\.tgz -C \/usr\/local/u,
    "the patch must not target a single hardcoded npm prefix",
  );
  assert.equal(
    [...source.matchAll(
      /for un_dir in \$\(find \/usr -type d \\\( -path '\*\/node_modules\/npm\/node_modules\/undici' -o -path '\*\/node_modules\/pnpm\/dist\/node_modules\/undici' \\\)/gu,
    )].length,
    2,
    "both runtime flavors must patch the undici vendored by every npm root and by pnpm",
  );
  // The Playwright base's OpenSSL must be upgraded to a fixed Ubuntu build.
  assert.equal(
    argumentDefaults(source).get("WEBDEV_OPENSSL_MIN_VERSION"),
    "3.0.13-0ubuntu3.16",
  );
  const webdevStage = source.slice(source.indexOf("FROM ${WEBDEV_BASE} AS runtime-webdev"));
  for (const pkg of ["libssl3t64", "openssl"]) {
    assert.match(
      webdevStage,
      new RegExp(`dpkg-query -W -f='\\$\\{Version\\}' ${pkg}\\)" ge "\\$\\{WEBDEV_OPENSSL_MIN_VERSION\\}"`, "u"),
      `webdev must verify ${pkg} reaches the fixed OpenSSL build`,
    );
  }
  // Each flavor fails the build if any vendored copy is left unpatched.
  assert.equal(
    [...source.matchAll(/unpatched npm tar copies/gu)].length,
    2,
    "both runtime flavors must fail closed on a remaining vulnerable copy",
  );
  assert.equal(
    [...source.matchAll(/unpatched brace-expansion copies/gu)].length,
    2,
    "both runtime flavors must fail closed on a remaining vulnerable copy",
  );
  assert.equal(
    [...source.matchAll(/unpatched ip-address copies/gu)].length,
    2,
    "both runtime flavors must fail closed on a remaining vulnerable copy",
  );
  assert.equal(
    [...source.matchAll(/unpatched undici copies/gu)].length,
    2,
    "both runtime flavors must fail closed on a remaining vulnerable copy",
  );

  // Anchor each download on its own URL/target rather than "first curl in the
  // stage": the stages also contain the npm dependency patch downloads.
  const ratholeCurl = 'curl --proto \'=https\' --tlsv1.2 --fail --location --silent --show-error -o /tmp/rathole.zip';
  const firstRathole = source.indexOf(
    ratholeCurl,
    source.indexOf("FROM ${RUNTIME_BASE} AS runtime"),
  );
  const webdev = source.indexOf("FROM ${WEBDEV_BASE} AS runtime-webdev");
  const uBlockDownload = source.indexOf("ublock.zip", webdev);
  const secondRathole = source.indexOf(ratholeCurl, uBlockDownload + 1);
  for (const [label, start, archive, extraction] of [
    ["runtime Rathole", firstRathole, "/tmp/rathole.zip", "unzip -q /tmp/rathole.zip"],
    ["webdev uBlock", uBlockDownload, "/tmp/ublock.zip", "unzip -q /tmp/ublock.zip"],
    ["webdev Rathole", secondRathole, "/tmp/rathole.zip", "unzip -q /tmp/rathole.zip"],
  ]) {
    const verify = source.indexOf("sha256sum --check --status", start);
    const use = source.indexOf(extraction, start);
    assert.ok(start >= 0, `${label} download is missing`);
    assert.ok(source.indexOf(archive, start) < verify, `${label} archive is not downloaded`);
    assert.ok(verify > start && verify < use, `${label} must verify before extraction`);
  }
});

test("tunnel broker verifies the selected Rathole asset", () => {
  const relativePath = "packages/tunnel-broker/Dockerfile";
  const source = read(relativePath);
  assertPinnedChecksumArgument(
    source,
    "RATHOLE_SHA256_AMD64",
    "3e7d0d0f365120cd3cd351d147d1a12ee960c8068b464d4dd533a3821873b80e",
    relativePath,
  );
  assertPinnedChecksumArgument(
    source,
    "RATHOLE_SHA256_ARM64",
    "fa4a6fc63d86f8f1faa7c103a845e4715ce79a048455c0eec897b27237576564",
    relativePath,
  );
  assertOrdered(
    source,
    relativePath,
    "curl --proto '=https' --tlsv1.2",
    "sha256sum --check --status",
    "unzip -j /tmp/rathole.zip",
  );
});

test("cargo-chef installation is version-locked", () => {
  for (const relativePath of ["docker/runtime/Dockerfile", "docker/proxy/Dockerfile"]) {
    const source = read(relativePath);
    assert.match(source, /^ARG CARGO_CHEF_VERSION=0\.1\.77$/mu);
    const installs = [
      ...source.matchAll(
        /^RUN cargo install cargo-chef --version "\$\{CARGO_CHEF_VERSION\}" --locked$/gmu,
      ),
    ];
    assert.equal(installs.length, 1, `${relativePath} must pin its cargo-chef install`);
  }
});

test("runtime Rust dependencies compile into a layer the publisher's layer cache keeps", () => {
  const source = read("docker/runtime/Dockerfile");
  const instructions = (stage) =>
    dockerfileStage(source, stage).split(/(?<!\\)\n/u).filter((line) => line.trim());
  const deps = instructions("builder-deps");
  const builder = instructions("builder");
  const targetMount = /--mount=type=cache,target=\/src\/packages\/runtime-agent\/target(\S*)/gu;

  // Exported layer caches never include cache mounts, so the cook must write
  // target/ into its own layer.
  const cook = deps.filter((line) => line.includes("cargo chef cook"));
  assert.equal(cook.length, 1);
  assert.match(cook[0], /^RUN /u);
  assert.match(cook[0], /--profile \$\{BUILD_PROFILE\} --recipe-path \/src\/recipe\.json --locked$/u);
  assert.equal([...deps.join("\n").matchAll(targetMount)].length, 0);

  // The application build starts from the cooked layer, and its only target
  // mount is seeded from that layer rather than starting empty.
  assert.equal(builder[0], "FROM builder-deps AS builder");
  // The path crates reach the builder only through builder-deps, with the
  // content and mtimes they were cooked from. Copying a fresh checkout over
  // them makes every file newer than the cook, and cargo recompiles codex-rs.
  for (const path of ["packages/runtime-contracts", "packages/openai-proxy-server", "packages/origin-http-server", "codex", "proto"]) {
    assert.ok(deps.includes(`COPY --from=chef /src/${path} /src/${path}`), path);
  }
  assert.deepEqual(
    builder.filter((line) => /^(?:COPY|ADD) /u.test(line)),
    ["COPY packages/runtime-agent/ packages/runtime-agent/"],
  );
  const build = builder.filter((line) => line.includes("cargo build"));
  assert.equal(build.length, 1);
  assert.deepEqual(
    [...builder.join("\n").matchAll(targetMount)].map((match) => match[1]),
    [",from=builder-deps,source=/src/packages/runtime-agent/target"],
  );
  assert.ok(build[0].includes("--mount=type=cache,target=/src/packages/runtime-agent/target,from=builder-deps,"));

  // One registry layer cache per image and architecture cell, in a dedicated
  // package that is never the release package. This deliberately reverses the
  // earlier "never a registry cache" rule (#409): one release's mode=max export
  // does not fit the repository's GitHub Actions cache, so it evicted itself
  // and every CI cache. The build before the scan only reads the cache,
  // anonymously, so the scan still precedes any registry login; the cache is
  // written only after the scanned image is pushed and recorded.
  // Trust boundary: unlike an Actions cache scoped to main, the tag can be
  // overwritten by any workflow run of this repository, on any branch, that
  // holds packages: write, and by package administrators. Fork pull request
  // runs get a read-only token; a pull_request_target workflow would run with
  // this repository's token, so the next test keeps every pull-request-triggered
  // workflow without packages: write. The image scan would not detect layers
  // seeded that way; docs/Testing.md describes how to reset it.
  const services = read(".github/workflows/publish-production-services.yml");
  const cacheRef =
    "ghcr.io/instafy-dev/instafy-build-cache:publish-runtime-agent-${{ matrix.flavor }}-${{ matrix.architecture }}";
  // Services build without a layer cache: their Actions-cache flags were inert,
  // and a registry cache would publish their private image layers.
  assert.doesNotMatch(services, /type=gha/u);
  assert.doesNotMatch(services, /cache-(?:from|to)\b|type=registry/u);

  // Each runtime cell keeps its own cache tag; the amd64 and arm64 tags are
  // written by their respective publishers.
  for (const { file } of runtimePublishers) {
    const workflow = read(`.github/workflows/${file}`);
    assert.doesNotMatch(workflow, /type=gha/u);
    const login = workflow.indexOf("      - name: Login to GHCR\n");
    const audit = workflowStep(workflow, "Build audit image");
    const exported = workflowStep(workflow, "Export the scanned build's layer cache");
    assert.ok(login > 0 && workflow.indexOf(audit) < login && workflow.indexOf(exported) > login);
    assert.deepEqual(
      [...workflow.matchAll(/(?:^|\s)(--)?cache-(from|to)\b/gmu)].map((match) => `${match[1] ?? ""}cache-${match[2]}`),
      ["cache-from", "--cache-to"],
      "one cache read in the audit build and one cache write in the export, nothing else",
    );
    const cacheFrom = `          cache-from: type=registry,ref=${cacheRef}\n`;
    assert.equal(workflow.split(cacheFrom).length, 2);
    assert.ok(audit.includes(cacheFrom), "the cache is read only by the build before the scan");
    assert.ok(exported.includes(`          CACHE_REF: ${cacheRef}\n`));
    assert.ok(
      exported.includes(
        '--cache-to "type=registry,ref=${CACHE_REF},mode=max,oci-mediatypes=true,image-manifest=true,ignore-error=true"',
      ),
      "the export keeps every intermediate layer (mode=max) and never fails a release",
    );
    assert.deepEqual(
      [...workflow.matchAll(/type=registry,ref=([^,"\n]+)/gu)].map((match) => match[1]),
      [cacheRef, "${CACHE_REF}"],
    );
    assert.doesNotMatch(workflow, /instafy-runtime-agent:[^\s"]*cache|ref=ghcr\.io\/instafy-dev\/instafy-runtime-agent/u);
  }
});

test("no pull-request-triggered workflow can write packages, including the layer cache", () => {
  // The cache's trust boundary relies on this: a pull_request_target workflow
  // runs with this repository's token, and any workflow that requested
  // packages: write could overwrite the cache tag.
  const directory = path.join(repositoryRoot, ".github/workflows");
  const writers = [];
  for (const file of fs.readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    const source = read(`.github/workflows/${file}`);
    const trigger = source.match(/^(?:on|"on"):(.*\n(?:(?:[ #].*)?\n)*)/mu);
    assert.ok(trigger, `${file} has no top-level on:`);
    const canWrite = /\bpackages: write\b|\bwrite-all\b/u.test(source);
    if (canWrite) writers.push(file);
    if (/\bpull_request(?:_target)?\b/u.test(trigger[1])) {
      assert.ok(!canWrite, `${file} runs for pull requests and must not request packages: write`);
    }
  }
  assert.deepEqual(writers, [
    "mirror-supabase-images.yml",
    "publish-production-services.yml",
    "publish-runtime-agent-multiarch.yml",
    "publish-runtime-agent.yml",
  ]);
});

test("each release rebuilds its final stage while the layer cache keeps the compiled builders", () => {
  // A persistent cache would keep a final stage's apt and npm layers until
  // their inputs change. The scan ignores unfixed findings, so a fix published
  // upstream would then fail every release until the cache was reset. Filter
  // only the final stage: the builder stages (the cargo-chef cook above all)
  // are what the cache is for.
  let targets;
  for (const { file } of runtimePublishers) {
    const workflow = read(`.github/workflows/${file}`);
    const audit = workflowStep(workflow, "Build audit image");
    assert.match(audit, /^          target: \$\{\{ matrix\.target \}\}$/mu);
    assert.match(audit, /^          no-cache-filters: \$\{\{ matrix\.target \}\}$/mu);
    assert.match(workflowStep(workflow, "Scan audit image"), /--ignore-unfixed/u);
    targets = [...new Set([...workflow.matchAll(/^            target: (\S+)$/gmu)].map((match) => match[1]))];
    assert.deepEqual(targets, ["runtime", "runtime-webdev"]);
  }

  const dockerfile = read("docker/runtime/Dockerfile");
  const stageNames = new Set(
    [...dockerfile.matchAll(/^FROM(?: --platform=\S+)? \S+ AS (\S+)$/gmu)].map((match) => match[1]),
  );
  for (const target of targets) {
    const stage = dockerfileStage(dockerfile, target);
    const base = stage.match(/^FROM(?: --platform=\S+)? (\S+) AS /u)[1];
    assert.ok(!stageNames.has(base), `${target} must not build on another stage the filter would also rebuild`);
    assert.match(stage, /apt-get install/u, `${target} installs the OS packages the scan must see current`);
    assert.match(stage, /npm install -g/u, `${target} installs the npm packages the scan must see current`);
    assert.doesNotMatch(stage, /\bcargo (?:build|chef)\b|\bgo build\b/u, `${target} must not compile`);
  }
});

test("runtime publication scans each native architecture before registry login", () => {
  for (const publisher of runtimePublishers) {
    const source = read(`.github/workflows/${publisher.file}`);
    const cleanup = source.indexOf(
      "- name: Reclaim hosted-runner disk for the audited image",
    );
    const login = source.indexOf("- name: Login to GHCR");
    const push = source.indexOf(
      "- name: Push scanned image and record its digest",
    );
    const firstBuild = source.indexOf("- name: Build audit image");
    assert.ok(cleanup > 0 && cleanup < firstBuild);
    assertOrdered(
      source.slice(cleanup, firstBuild),
      "runtime publication disk cleanup",
      "sudo rm -rf --",
      "/opt/ghc",
      "/usr/local/lib/android",
      "/usr/share/dotnet",
      "available_kib < 20 * 1024 * 1024",
    );
    assert.ok(login > 0 && push > login, "runtime publication login/push order is malformed");
    const beforeLogin = source.slice(0, login);

    // Each flavor×architecture cell builds NATIVELY on an architecture-matched
    // hosted runner — no QEMU emulation anywhere in the workflow. Production
    // builds only amd64; the arm64 lane builds only arm64.
    assert.doesNotMatch(source, /setup-qemu/u);
    assert.doesNotMatch(source, /binfmt/u);
    assert.equal([...beforeLogin.matchAll(/^            runner: (\S+)$/gmu)].map((match) => match[1]).join(),
      [publisher.runner, publisher.runner].join());
    assert.equal([...beforeLogin.matchAll(/^            platform: (\S+)$/gmu)].map((match) => match[1]).join(),
      [`linux/${publisher.architecture}`, `linux/${publisher.architecture}`].join());
    assert.doesNotMatch(beforeLogin, new RegExp(`platform: linux/${publisher.other}`, "u"));
    assertOrdered(
      beforeLogin,
      "runtime publication",
      "- name: Build audit image",
      "platforms: ${{ matrix.platform }}",
      "load: true",
      "- name: Scan audit image",
    );
    assert.equal(
      [...beforeLogin.matchAll(/"\$AUDIT_IMAGE"/gu)].length,
      1,
      "each cell must scan its exact local image before login",
    );
    // The scan must be blocking and complete: vuln+secret, HIGH/CRITICAL,
    // non-zero exit — asserted against the pre-login section so weakening the
    // runtime gate (not just the services gate) fails the suite.
    assert.match(beforeLogin, /--scanners vuln,secret/u);
    assert.match(beforeLogin, /--severity HIGH,CRITICAL/u);
    assert.match(beforeLogin, /--exit-code 1/u);
    // Trivy pinning must be enforced, not just declared as matrix data:
    // download -> checksum verification -> extraction -> version equality.
    assert.match(beforeLogin, /TRIVY_VERSION: "0\.72\.0"/u);
    assertOrdered(
      beforeLogin,
      "runtime Trivy install",
      "- name: Install pinned Trivy",
      "curl --proto '=https' --tlsv1.2",
      "sha256sum --check --status",
      "tar -xzf",
      'test "$(trivy --version',
    );
    // Nothing before login writes to a registry: no push, cache export or
    // credential-bearing step.
    assert.doesNotMatch(beforeLogin, /cache-to|--push\b|push: true|docker push|docker\/login-action/u);
    // The build job holds no credential before login, so the registry cache read
    // stays anonymous. (The authorize job reads the API with its own token.)
    const jobStart = source.indexOf(`\n  ${publisher.job}:\n`);
    assert.ok(jobStart > 0 && jobStart < login);
    assert.doesNotMatch(
      source.slice(jobStart, login),
      /docker login|secrets\.|github\.token|GITHUB_TOKEN|registry-auth|DOCKER_AUTH_CONFIG|DOCKER_CONFIG|credHelpers|credsStore/u,
      "no build-scan-push step before Login to GHCR may hold or configure a credential",
    );
    const afterLogin = source.slice(login);
    assert.doesNotMatch(
      afterLogin,
      /docker\/build-push-action/u,
      "publication must not rebuild after the scan gate",
    );
    // The only build after login is the layer cache export, and it runs only
    // once the scanned image is pushed and its record uploaded. It writes cache
    // blobs and nothing else: no image output, push, load or tag.
    assertOrdered(
      afterLogin,
      "runtime cache export",
      "- name: Push scanned image and record its digest",
      "- name: Upload immutable architecture record",
      "- name: Export the scanned build's layer cache",
      `\n  ${publisher.next}:\n`,
    );
    const exported = workflowStep(source, "Export the scanned build's layer cache");
    assert.equal([...afterLogin.matchAll(/docker buildx build/gu)].length, 1);
    assert.match(exported, /docker buildx build/u);
    assert.equal([...exported.matchAll(/--output\b/gu)].length, 1);
    assert.match(exported, /^            --output type=cacheonly \\$/mu);
    assert.doesNotMatch(
      exported,
      /--push\b|--load\b|--tag\b|(?:^|\s)-[to]\s|push=true|type=(?:image|docker|oci|local|tar)\b|no-cache/mu,
      "the cache export must not produce, push or load an image, or rebuild a filtered stage",
    );
    assert.doesNotMatch(exported, /continue-on-error|^\s+if:/mu);
    assert.doesNotMatch(
      source,
      /docker save/u,
      "image bytes must never be exported as workflow artifacts",
    );
    assert.match(afterLogin, /docker push "\$ARCH_TAG"/u);
  }
  // Production seals the scanned amd64 images themselves; only the arm64
  // lane creates multi-arch indexes, from those exact digests.
  const production = read(".github/workflows/publish-runtime-agent.yml");
  assert.doesNotMatch(production, /imagetools create/u);
  const multiarch = read(".github/workflows/publish-runtime-agent-multiarch.yml");
  const assemble = multiarch.slice(multiarch.indexOf("\n  assemble-multiarch:\n"));
  assert.match(assemble, /docker buildx imagetools create/u);
  assert.match(assemble, /--metadata-file "\$metadata"/u);
  assert.match(assemble, /\.\["containerimage\.descriptor"\]\.digest/u);
  assert.match(assemble, /\["linux\/amd64","linux\/arm64"\]/u);
  assert.ok(assemble.indexOf("Re-scan the sealed amd64 images from the registry") < assemble.indexOf("- name: Login to GHCR"));
});

test("the layer cache export repeats the scanned build exactly and can only warn", () => {
  // The amd64 base cell of the production release and the arm64 webdev cell
  // of the multi-arch lane, each replayed with its own cell's values.
  for (const [file, cell] of [
    ["publish-runtime-agent.yml", { TARGET: "runtime", PLATFORM: "linux/amd64", key: "base-amd64" }],
    ["publish-runtime-agent-multiarch.yml", { TARGET: "runtime-webdev", PLATFORM: "linux/arm64", key: "webdev-arm64" }],
  ]) {
    const workflow = read(`.github/workflows/${file}`);
    const audit = workflowStep(workflow, "Build audit image");
    const exported = workflowStep(workflow, "Export the scanned build's layer cache");
    const input = (name) => audit.match(new RegExp(`^          ${name}: (.+)$`, "mu"))?.[1];
    const block = (name) =>
      audit.match(new RegExp(`^          ${name}: \\|\\n((?:            .+\\n)+)`, "mu"))[1]
        .split("\n").filter(Boolean).map((line) => line.trim());
    const env = Object.fromEntries(
      exported.match(/^        env:\n((?:          [A-Z_]+: .+\n)+)/mu)[1]
        .split("\n").filter(Boolean).map((line) => line.trim().split(/: (.*)/u).slice(0, 2)),
    );
    // The export uses the builder that holds this job's BuildKit state, and the
    // same target and platform as the audit build.
    const buildx = workflowStep(workflow, "Set up Docker Buildx");
    assert.ok(workflow.indexOf(buildx) < workflow.indexOf(audit));
    assert.match(buildx, /^        id: buildx$/mu);
    assert.doesNotMatch(buildx, /^          use: false$/mu);
    assert.equal(input("builder"), undefined, "the audit build uses the builder selected by setup-buildx");
    assert.deepEqual(env, {
      BUILDER: "${{ steps.buildx.outputs.name }}",
      TARGET: input("target"),
      PLATFORM: input("platforms"),
      RELEASE_COMMIT: "${{ needs.authorize.outputs.commit_sha }}",
      CACHE_REF:
        "ghcr.io/instafy-dev/instafy-build-cache:publish-runtime-agent-${{ matrix.flavor }}-${{ matrix.architecture }}",
    });
    assert.equal(input("provenance"), "false");
    assert.equal(input("sbom"), "false");

    const script = exported.match(/^        run: \|\n((?:(?:          .*)?\n)+)/mu)[1].replace(/^ {10}/gmu, "");
    // The stubs below must shadow the real tools; an absolute path would not.
    assert.doesNotMatch(script, /\/(?:docker|timeout)\b/u);
    const values = {
      BUILDER: "builder-under-test",
      TARGET: cell.TARGET,
      PLATFORM: cell.PLATFORM,
      RELEASE_COMMIT: "a".repeat(40),
      CACHE_REF: `ghcr.io/instafy-dev/instafy-build-cache:publish-runtime-agent-${cell.key}`,
    };
    const expected = [
      "buildx", "build",
      "--builder", values.BUILDER,
      "--progress=plain",
      "--platform", values.PLATFORM,
      "--file", input("file"),
      "--target", values.TARGET,
      ...block("build-args").flatMap((arg) => ["--build-arg", arg]),
      ...block("labels").flatMap((label) => [
        "--label",
        label.replaceAll("${{ needs.authorize.outputs.commit_sha }}", values.RELEASE_COMMIT),
      ]),
      "--provenance=false",
      "--sbom=false",
      "--output", "type=cacheonly",
      "--cache-to",
      `type=registry,ref=${values.CACHE_REF},mode=max,oci-mediatypes=true,image-manifest=true,ignore-error=true`,
      input("context"),
    ];
    assert.equal(input("context"), ".");

    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cache-export-"));
    try {
      const log = path.join(bin, "log");
      // timeout records its own options and runs the command it bounds; docker
      // records its argv and exits with the requested status.
      fs.writeFileSync(path.join(bin, "timeout"),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_LOG.timeout"\nshift 2\nexec "$@"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "docker"),
        '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$FAKE_LOG.docker"\n' +
          'printf \'%s\' "$FAKE_DOCKER_PROGRESS" >&2\nexit "$FAKE_DOCKER_STATUS"\n',
        { mode: 0o755 });
      const run = (status, progress = "") => {
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...values,
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_LOG: log,
            FAKE_DOCKER_STATUS: String(status),
            FAKE_DOCKER_PROGRESS: progress,
          },
        });
        return {
          status: result.status,
          stdout: result.stdout,
          timeout: fs.readFileSync(`${log}.timeout`, "utf8").split("\n").filter(Boolean),
          docker: fs.readFileSync(`${log}.docker`, "utf8").split("\n").slice(0, -1),
        };
      };
      const ok = run(0);
      assert.equal(ok.status, 0);
      assert.doesNotMatch(ok.stdout, /::warning::/u);
      assert.deepEqual(ok.docker, expected);
      assert.deepEqual(ok.timeout.slice(0, 5), ["--kill-after=1m", "15m", "docker", "buildx", "build"]);
      // A failed export or an expired bound (124/137) never fails the release.
      for (const status of [1, 124, 137]) {
        const failed = run(status);
        assert.equal(failed.status, 0, `export status ${status} must not fail the job`);
        assert.match(failed.stdout, new RegExp(`^::warning::.*status ${status}\\b`, "mu"));
      }
      // ignore-error=true lets the build succeed when only the cache write
      // failed; BuildKit then reports it as an ERROR line in the plain progress
      // log, and the step must still warn.
      const clean = run(0, "#14 exporting cache to registry\n#14 DONE 2.1s\n");
      assert.equal(clean.status, 0);
      assert.doesNotMatch(clean.stdout, /::warning::/u);
      const denied = run(0, "#14 exporting cache to registry\n#14 ERROR: failed to push: denied\n");
      assert.equal(denied.status, 0);
      assert.match(denied.stdout, /^#14 ERROR: failed to push: denied$/mu, "the progress log stays in the step log");
      assert.match(denied.stdout, /^::warning::The layer cache export reported an error\b/mu);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }
});

test("the runtime entrypoint finds Playwright's Chromium in either build layout", async () => {
  // Production Shared Browser runtimes started no Chromium: the pinned
  // Playwright 1.61 base unpacks it to chrome-linux64/, which the entrypoint
  // did not search, so it logged "no Chromium executable found".
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const entrypoint = read("docker/runtime/entrypoint.sh");
  const start = entrypoint.indexOf("resolve_chromium_executable_path() {");
  const end = entrypoint.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "resolve_chromium_executable_path must exist");
  const resolver = entrypoint.slice(start, end + 3);

  for (const layout of ["chrome-linux64", "chrome-linux"]) {
    const browsers = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-playwright-"));
    try {
      const chrome = path.join(browsers, "chromium-1187", layout, "chrome");
      fs.mkdirSync(path.dirname(chrome), { recursive: true });
      fs.writeFileSync(chrome, "#!/bin/sh\n");
      fs.chmodSync(chrome, 0o755);
      const resolved = execFileSync("bash", ["-c", `${resolver}\nresolve_chromium_executable_path`], {
        encoding: "utf8",
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
      });
      assert.equal(resolved, chrome, layout);
    } finally {
      fs.rmSync(browsers, { recursive: true, force: true });
    }
  }
});

test("a webdev image must start the Shared Browser before it is published", () => {
  for (const { file } of runtimePublishers) {
    const publish = read(`.github/workflows/${file}`);
    const scan = publish.indexOf("- name: Scan audit image");
    const gate = publish.indexOf("- name: Prove the webdev image starts the Shared Browser");
    const login = publish.indexOf("- name: Login to GHCR");
    assert.ok(scan > 0 && gate > scan && login > gate, `${file}: the browser gate runs after the scan and before any registry login`);
    const step = publish.slice(gate, login);
    assert.match(step, /if: \$\{\{ matrix\.flavor == 'webdev' \}\}/u);
    assert.match(step, /run: bash scripts\/runtime-image-browser-smoke\.sh "\$BROWSER_SMOKE_IMAGE"/u);
  }

  const smoke = read("scripts/runtime-image-browser-smoke.sh");
  // It boots the image's real entrypoint and swaps only the final exec.
  assert.match(smoke, /exec \/usr\/local\/bin\/runtime-agent/u);
  assert.match(smoke, /INSTAFY_ENABLE_BROWSER_SESSION=1/u);
  assert.match(smoke, /\/json\/version/u);
  assert.ok(fs.statSync(path.join(repositoryRoot, "scripts/runtime-image-browser-smoke.sh")).mode & 0o111);

  const pr = read(".github/workflows/runtime-browser-smoke.yml");
  assert.match(pr, /- docker\/runtime\/entrypoint\.sh/u);
  assert.match(pr, /permissions:\n  contents: read/u);
  assert.doesNotMatch(pr, /secrets\./u);
  assert.match(pr, /runtime-image-browser-smoke\.sh "\$IMAGE" docker\/runtime\/entrypoint\.sh/u);
  // Every production release pushes the amd64 architecture tag; the multi-arch
  // webdev-<sha> tag exists only once the arm64 lane has succeeded.
  assert.match(pr, /candidate="ghcr\.io\/instafy-dev\/instafy-runtime-agent:webdev-\$\{sha\}-linux-amd64"/u);
  assert.match(pr, /^    runs-on: ubuntu-24\.04$/mu);
});

const fetchRustyV8 = path.join(repositoryRoot, "scripts/fetch-rusty-v8.sh");
const checksumsName = "rusty_v8_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.sha256";

function rustyV8Fixture({ lock, manifest }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-rusty-v8-"));
  const lockfile = path.join(root, "Cargo.lock");
  fs.writeFileSync(lockfile, lock);
  const codexDir = path.join(root, "codex");
  fs.mkdirSync(path.join(codexDir, "third_party/v8"), { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(
      path.join(codexDir, "third_party/v8/rusty_v8_150_4_0_release_manifests.sha256"),
      manifest,
    );
  }
  return { root, lockfile, codexDir, output: path.join(root, "out") };
}

// Every case below fails before the first download, so no test touches the network.
function runFetchRustyV8(args, { lockfile, codexDir }) {
  const result = spawnSync("bash", [fetchRustyV8, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUSTY_V8_LOCKFILE: lockfile, CODEX_DIR: codexDir },
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const lockWith = (...versions) =>
  versions.map((version) => `[[package]]\nname = "v8"\nversion = "${version}"\n`).join("\n");

test("fetch-rusty-v8 rejects a malformed target before reading anything", () => {
  const paths = rustyV8Fixture({ lock: lockWith("150.4.0"), manifest: "" });
  const result = runFetchRustyV8(["x86_64; rm -rf /", paths.output], paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid Rust target triple/u);
  assert.equal(fs.existsSync(paths.output), false);
});

test("fetch-rusty-v8 needs exactly one locked v8 version", () => {
  for (const [lock, message] of [
    ["", /no v8 package/u],
    [lockWith("150.4.0", "149.2.0"), /more than one v8 version/u],
  ]) {
    const paths = rustyV8Fixture({ lock, manifest: "" });
    const result = runFetchRustyV8(["x86_64-unknown-linux-gnu", paths.output], paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("fetch-rusty-v8 refuses a v8 version the codex checkout pins no checksums for", () => {
  const paths = rustyV8Fixture({ lock: lockWith("150.4.0"), manifest: undefined });
  const result = runFetchRustyV8(["x86_64-unknown-linux-gnu", paths.output], paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing pinned checksum manifest/u);
});

test("fetch-rusty-v8 refuses a target the pinned manifest does not list, before any download", () => {
  const paths = rustyV8Fixture({
    lock: lockWith("150.4.0"),
    manifest: `${"0".repeat(64)}  ${checksumsName}\n`,
  });
  const result = runFetchRustyV8(["aarch64-unknown-linux-musl", paths.output], paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pins no checksum for rusty_v8_ptrcomp_sandbox_release_aarch64-unknown-linux-musl\.sha256/u);
  assert.equal(fs.existsSync(paths.output), false);
});

test("the checked-in codex checkout pins the locked v8 version for both runtime image architectures", () => {
  const lock = fs.readFileSync(path.join(repositoryRoot, "packages/runtime-agent/Cargo.lock"), "utf8");
  const versions = [...lock.matchAll(/^name = "v8"\nversion = "([^"]+)"$/gmu)].map((match) => match[1]);
  assert.equal(versions.length, 1, `one locked v8 version, found ${versions}`);
  const manifest = path.join(
    repositoryRoot,
    `codex/third_party/v8/rusty_v8_${versions[0].replaceAll(".", "_")}_release_manifests.sha256`,
  );
  const pinned = fs.readFileSync(manifest, "utf8");
  for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
    assert.match(pinned, new RegExp(`^[0-9a-f]{64}  rusty_v8_ptrcomp_sandbox_release_${target}\\.sha256$`, "mu"));
  }
});

test("runtime images build the code-mode host with its V8 and install it beside runtime-agent", () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, "docker/runtime/Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY codex\/third_party\/v8\/ codex\/third_party\/v8\/$/mu);
  assert.match(dockerfile, /^RUN \/src\/scripts\/fetch-rusty-v8\.sh "\$\(rustc -vV \| sed -n 's\/\^host: \/\/p'\)" \/opt\/rusty_v8$/mu);
  assert.match(dockerfile, /cargo chef cook --features code-mode-host /u);
  assert.match(dockerfile, /--features code-mode-host -p runtime-agent -p codex-code-mode-host --locked/u);
  // The binary export and both runtime flavors carry the host next to runtime-agent.
  assert.equal(
    [...dockerfile.matchAll(/^COPY --from=builder \S+\/codex-code-mode-host \/usr\/local\/bin\/codex-code-mode-host$/gmu)].length,
    2,
  );
  assert.match(dockerfile, /^COPY --from=builder \S+\/codex-code-mode-host \/codex-code-mode-host$/mu);
  const ignore = fs.readFileSync(path.join(repositoryRoot, ".dockerignore"), "utf8").split("\n");
  for (const entry of ["!codex/third_party/v8/**", "!scripts/fetch-rusty-v8.sh"]) {
    assert.ok(ignore.includes(entry), entry);
  }
});
