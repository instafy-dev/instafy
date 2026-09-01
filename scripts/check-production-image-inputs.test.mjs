import assert from "node:assert/strict";
import fs from "node:fs";
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

function dockerfileFromReferences(source) {
  return [...source.matchAll(/^FROM(?: --platform=\S+)? (\S+)/gmu)].map(
    (match) => match[1],
  );
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
    "151.0.7922.173-1~deb13u1",
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
  assert.equal(argumentDefaults(source).get("OPENSSL_VERSION"), "3.5.8-r0");
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
    9,
    "runtime and webdev downloads must each verify their archive",
  );
  assert.equal(
    [...source.matchAll(/curl --proto '=https' --tlsv1\.2/gu)].length,
    9,
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
    "5.0.9",
  );
  assertPinnedChecksumArgument(
    source,
    "BRACE_EXPANSION_SHA256",
    "5d06001fddd25cbee90c96db4dc5b7b57711b984c3141e28d10f143deb52dbaf",
    relativePath,
  );
  assert.equal(argumentDefaults(source).get("IP_ADDRESS_VERSION"), "10.3.1");
  assertPinnedChecksumArgument(
    source,
    "IP_ADDRESS_SHA256",
    "ad1790063beea11a312c801df30d58e147de762f4f77787552376eb7424623e5",
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

test("runtime publication scans each native architecture before registry login", () => {
  const source = read(".github/workflows/publish-runtime-agent.yml");
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
  // hosted runner — no QEMU emulation anywhere in the workflow.
  assert.doesNotMatch(source, /setup-qemu/u);
  assert.doesNotMatch(source, /binfmt/u);
  assert.match(beforeLogin, /runner: ubuntu-24\.04\n/u);
  assert.match(beforeLogin, /runner: ubuntu-24\.04-arm\n/u);
  assert.match(beforeLogin, /platform: linux\/amd64/u);
  assert.match(beforeLogin, /platform: linux\/arm64/u);
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
  const afterLogin = source.slice(login);
  assert.doesNotMatch(
    afterLogin,
    /docker\/build-push-action/u,
    "publication must not rebuild after the scan gate",
  );
  assert.doesNotMatch(
    source,
    /docker save/u,
    "image bytes must never be exported as workflow artifacts",
  );
  assert.match(afterLogin, /docker push "\$ARCH_TAG"/u);
  assert.match(afterLogin, /docker buildx imagetools create/u);
  assert.match(afterLogin, /--metadata-file "\$metadata"/u);
  assert.match(afterLogin, /\.\["containerimage\.descriptor"\]\.digest/u);
  assert.match(afterLogin, /\["linux\/amd64","linux\/arm64"\]/u);
});
