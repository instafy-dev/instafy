import assert from "node:assert/strict";

// Test-only inverse of the finite routing/builder delta; not runtime authority.
const amd64Builder = "image=moby/buildkit@sha256:040d34121c27906c4ff9ac152a30d52bf2c5d328d3bb748916bb3d2743c02528";
const builderDeltas = {
  "publish-production-services.yml": `          # Match the amd64 build target so an ARM Docker host uses its registered
          # translator, not BuildKit's QEMU fallback after a failed x86 probe.
          driver-opts: \${{ runner.environment == 'self-hosted' && '${amd64Builder}' || '' }}
`,
  "publish-runtime-agent.yml": `          # Only x86 targets need the amd64 BuildKit v0.32.2 image on BUILD.
          # Keep ARM targets and hosted builders native; never force ARM via QEMU.
          driver-opts: \${{ runner.environment == 'self-hosted' && matrix.architecture == 'amd64' && '${amd64Builder}' || '' }}
`,
};
export const imageBuildSelector = (file,fallback)=>`    runs-on: >-\n      \${{ vars.TRUSTED_AMD64_BUILD_RUNNER_MODE == 'self-hosted'\n          && github.repository == 'instafy-dev/instafy'\n          && github.repository_id == '1309636737'\n          && github.event.repository.private == true\n          && github.event_name == 'workflow_dispatch'\n          && github.ref == 'refs/heads/main'\n          && github.ref_protected == true\n          && github.workflow_ref == 'instafy-dev/instafy/.github/workflows/${file}@refs/heads/main'\n          && github.workflow_sha == github.sha\n          && inputs.commit_sha == github.sha\n          && fromJSON('{"group":"org/instafy-trusted-build","labels":["self-hosted","Linux","X64","instafy-build"]}')\n          || ${fallback} }}\n`;
export const coordinatorBuildBranch = `          || vars.TRUSTED_AMD64_BUILD_RUNNER_MODE == 'self-hosted'
          && github.repository == 'instafy-dev/instafy'
          && github.repository_id == '1309636737'
          && github.event.repository.private == true
          && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')
          && github.ref == 'refs/heads/main'
          && github.ref_protected == true
          && github.workflow_ref == 'instafy-dev/instafy/.github/workflows/continuous-image-publication.yml@refs/heads/main'
          && github.workflow_sha == github.sha
          && (github.event_name == 'schedule' || inputs.commit_sha == github.sha)
          && fromJSON('{"group":"org/instafy-trusted-build","labels":["self-hosted","Linux","X64","instafy-build"]}')
`;
export const coordinatorBuildPreflight = `      - name: Qualify trusted image reconciliation runner
        if: runner.environment == 'self-hosted' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')
        shell: bash
        run: |
          node <<'NODE'
          const assert = require('node:assert/strict');
          const { execFileSync } = require('node:child_process');
          assert.equal(process.env.GITHUB_REPOSITORY, 'instafy-dev/instafy');
          assert.equal(process.env.GITHUB_REPOSITORY_ID, '1309636737');
          assert.ok(['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
          assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
          assert.equal(process.env.GITHUB_REF_PROTECTED, 'true');
          assert.equal(process.env.GITHUB_WORKFLOW_REF, 'instafy-dev/instafy/.github/workflows/continuous-image-publication.yml@refs/heads/main');
          assert.match(process.env.GITHUB_SHA, /^[0-9a-f]{40}$/);
          assert.equal(process.env.GITHUB_WORKFLOW_SHA, process.env.GITHUB_SHA);
          assert.equal(process.platform, 'linux');
          assert.equal(process.arch, 'x64');
          assert.ok(Number.isSafeInteger(process.getuid()) && process.getuid() > 0);
          assert.equal(process.versions.node.split('.')[0], '22');
          assert.equal(process.env.RUNNER_OS, 'Linux');
          assert.equal(process.env.RUNNER_ARCH, 'X64');
          assert.ok(!process.env.INSTAFY_ENV_DIR);
          for (const tool of ['bash', 'gh', 'jq', 'date']) {
            execFileSync('/bin/bash', ['-c', 'command -v "$1" >/dev/null', 'public-image-build-preflight', tool], { timeout: 1000, stdio: 'ignore' });
          }
          assert.equal(execFileSync('date', ['-u', '-d', '1970-01-01T00:00:00Z', '+%s'], { timeout: 1000, encoding: 'utf8' }).trim(), '0');
          NODE

`;

export function withoutImageBuildRouting(file, source) {
  if (file === "continuous-image-publication.yml") {
    assert.equal(source.split(coordinatorBuildBranch).length, 2);
    assert.equal(source.split(coordinatorBuildPreflight).length, 2);
    const narrowed = "        if: runner.environment == 'self-hosted' && github.event_name == 'push'\n";
    assert.equal(source.split(narrowed).length, 2);
    return source.replace(coordinatorBuildBranch, "").replace(coordinatorBuildPreflight, "")
      .replace(narrowed, "        if: runner.environment == 'self-hosted'\n");
  }
  if (!["publish-production-services.yml", "publish-runtime-agent.yml"].includes(file)) return source;
  assert.equal(source.split(builderDeltas[file]).length, 2);
  source = source.replace(builderDeltas[file], "");
  const ordinary = imageBuildSelector(file, "'ubuntu-latest'");
  assert.equal(source.split(ordinary).length, file === "publish-production-services.yml" ? 5 : 4);
  let normalized = source.replaceAll(ordinary, "    runs-on: ubuntu-latest\n");
  if (file === "publish-runtime-agent.yml") {
    const comment = "      # Hosted cells build natively; the trusted BUILD daemon must support both\n      # target platforms. Scan each image before any registry login.\n";
    assert.equal(normalized.split(comment).length, 2);
    normalized = normalized.replace(comment, "      # Build and scan on the native architecture before any registry login.\n");
    const matrix = imageBuildSelector(file, "matrix.runner");
    assert.equal(normalized.split(matrix).length, 2);
    normalized = normalized.replace(matrix, "    runs-on: ${{ matrix.runner }}\n");
    for (const [key, original, replacement] of [
      ["TRIVY_ASSET", "matrix.trivy_asset", "runner.environment == 'self-hosted' && 'Linux-64bit' || matrix.trivy_asset"],
      ["TRIVY_SHA256", "matrix.trivy_sha256", "runner.environment == 'self-hosted' && 'bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea' || matrix.trivy_sha256"],
    ]) {
      const added = "          " + key + ": $" + "{{ " + replacement + " }}\n";
      assert.equal(normalized.split(added).length, 2);
      normalized = normalized.replace(added, "          " + key + ": $" + "{{ " + original + " }}\n");
    }
  }
  return normalized;
}
