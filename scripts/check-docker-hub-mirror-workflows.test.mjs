import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUILDKITD_MIRROR_CONFIG, discoverRepositoryImages, parseImageReference } from "./lib/dockerHubImageMirror.mjs";

// Every Buildx builder that can build an image either runs BuildKit with the
// GHCR Docker Hub mirror and a resolved, digest-pinned BuildKit image, or uses
// the docker driver in a job that builds nothing. A new builder that skips the
// mirror fails here instead of quietly depending on Docker Hub again.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = path.join(root, ".github/workflows");
const workflows = fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/u.test(file)).sort()
  .map((file) => ({ file, source: fs.readFileSync(path.join(workflowDir, file), "utf8") }));

function jobs(source) {
  const body = source.slice(source.indexOf("\njobs:\n") + 1);
  return [...body.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gmu)].map((match) => ({ key: match[1], source: match[0] }));
}

function steps(job) {
  return job.split(/(?=^ {6}- )/mu).slice(1);
}

const stepName = (step) => step.match(/^ {6}- name: (.+)$/mu)?.[1];
const input = (step, name) => step.match(new RegExp(`^ {10}${name}: (.*)$`, "mu"))?.[1];
const buildsImages = (job) => /docker\/build-push-action@|docker buildx build\b|docker build\b/u.test(job);

const builders = workflows.flatMap(({ file, source }) => jobs(source).flatMap((job) => steps(job.source)
  .map((step, index, all) => ({ file, job, step, index, all }))
  .filter(({ step }) => /^ {8}uses: docker\/setup-buildx-action@/mu.test(step))));

const blockScalar = (step, name) => {
  const match = step.match(new RegExp(`^ {10}${name}: \\|\\n((?: {12}.*\\n)+)`, "mu"));
  return match ? match[1].replace(/^ {12}/gmu, "") : null;
};

test("image-building workflows exist and every image build has a mirrored builder", () => {
  const building = workflows.filter(({ source }) => jobs(source).some((job) => buildsImages(job.source)));
  assert.deepEqual(building.map(({ file }) => file).sort(), [
    "image-scan.yml", "publish-production-services.yml", "publish-runtime-agent-multiarch.yml", "publish-runtime-agent.yml",
  ]);
  for (const { file, source } of building) {
    for (const job of jobs(source).filter((candidate) => buildsImages(candidate.source))) {
      const own = builders.filter((builder) => builder.file === file && builder.job.key === job.key);
      assert.equal(own.length, 1, `${file}/${job.key} sets up exactly one builder`);
      assert.equal(input(own[0].step, "driver"), undefined, `${file}/${job.key} builds with a docker-container builder`);
    }
  }
});

test("every docker-container builder uses the Docker Hub mirror and a resolved BuildKit image", () => {
  let mirrored = 0;
  for (const { file, job, step, index, all } of builders) {
    const where = `${file}/${job.key}`;
    const driver = input(step, "driver");
    if (driver === "docker") {
      // The docker driver runs no BuildKit container and ignores buildkitd config.
      assert.ok(!buildsImages(job.source), `${where} builds images with the docker driver`);
      assert.equal(input(step, "driver-opts"), undefined, where);
      continue;
    }
    assert.equal(driver, undefined, `${where} uses an unexpected driver`);
    mirrored += 1;
    assert.equal(blockScalar(step, "buildkitd-config-inline"), BUILDKITD_MIRROR_CONFIG, where);
    assert.equal(input(step, "driver-opts"), "image=${{ steps.buildkit.outputs.image }}", where);
    assert.equal(input(step, "buildkitd-config"), undefined, where);

    // The resolver runs immediately before, after the checkout that provides it.
    const resolver = all[index - 1];
    assert.equal(stepName(resolver), "Resolve the BuildKit image", where);
    assert.match(resolver, /^ {8}id: buildkit$/mu, where);
    assert.match(resolver, /^ {8}run: node scripts\/resolve-buildkit-image\.mjs$/mu, where);
    assert.doesNotMatch(resolver, /^ {8}(?:if|continue-on-error|shell|working-directory):/mu, where);
    assert.equal(all.filter((candidate) => /^ {8}id: buildkit$/mu.test(candidate)).length, 1, where);
    const checkout = all.findIndex((candidate) => /^ {8}uses: actions\/checkout@/mu.test(candidate));
    assert.ok(checkout >= 0 && checkout < index - 1, `${where} checks out the resolver first`);

    // Every image the selection can produce is a digest-pinned moby/buildkit reference.
    const selection = resolver.match(/^ {10}BUILDKIT_IMAGE: (.+)$/mu)?.[1];
    assert.ok(selection, where);
    const literals = selection.startsWith("${{") ? [...selection.matchAll(/'([^']*)'/gu)].map((match) => match[1])
      .filter((value) => value.includes("buildkit")) : [selection];
    assert.ok(literals.length > 0, where);
    for (const literal of literals) {
      const parsed = parseImageReference(literal);
      assert.ok(parsed?.dockerHub && parsed.path === "moby/buildkit" && parsed.digest && !parsed.tag, `${where}: ${literal}`);
    }
  }
  assert.equal(mirrored, 5, "image-scan x2, production services, runtime agent and multi-arch runtime");
});

test("hosted builders share one pinned BuildKit index; only self-hosted x86 builds use the amd64 image", () => {
  const index = "moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
  const amd64 = "moby/buildkit@sha256:040d34121c27906c4ff9ac152a30d52bf2c5d328d3bb748916bb3d2743c02528";
  const selections = workflows.flatMap(({ file, source }) =>
    [...source.matchAll(/^ {10}BUILDKIT_IMAGE: (.+)$/gmu)].map((match) => ({ file, value: match[1] })));
  assert.deepEqual(selections.map(({ file, value }) => [file, value]), [
    ["image-scan.yml", index],
    ["image-scan.yml", index],
    ["publish-production-services.yml", `\${{ runner.environment == 'self-hosted' && '${amd64}' || '${index}' }}`],
    ["publish-runtime-agent-multiarch.yml", index],
    ["publish-runtime-agent.yml", `\${{ runner.environment == 'self-hosted' && matrix.architecture == 'amd64' && '${amd64}' || '${index}' }}`],
  ]);
  // Both are mirrored, because discovery reads them from these workflows.
  const discovered = discoverRepositoryImages(root).images.filter((image) => image.path === "moby/buildkit")
    .map((image) => `moby/buildkit@${image.digest}`).sort();
  assert.deepEqual(discovered, [amd64, index].sort());
});

test("the resolver CLI writes the image output the builders read and rejects an unpinned image offline", () => {
  const script = fs.readFileSync(path.join(root, "scripts/resolve-buildkit-image.mjs"), "utf8");
  assert.match(script, /`image=\$\{image\}\\n`/u);
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-buildkit-")), "output");
  for (const value of ["", "moby/buildkit:buildx-stable-1", "moby/buildkit"]) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/resolve-buildkit-image.mjs")], {
      encoding: "utf8", env: { ...process.env, BUILDKIT_IMAGE: value, GITHUB_OUTPUT: output }, timeout: 30_000,
    });
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /BUILDKIT_IMAGE must be a digest-pinned moby\/buildkit reference/u);
    assert.ok(!fs.existsSync(output), "an invalid input writes no output");
  }
});
