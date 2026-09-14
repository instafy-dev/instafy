import { withoutManualCiRouting } from "./lib/manualCiRoutingTestBaseline.mjs";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = withoutManualCiRouting('build.yml', fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8'));
const aggregateIf = "    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}";
const agentLinkerDefault = `          if [[ '\${{ runner.environment == 'self-hosted' && runner.os == 'Linux' }}' == true && "\${RUSTFLAGS+x}" != x ]]; then
            export RUSTFLAGS='-C link-arg=-fuse-ld=lld'
          fi
`;
const checks = [
  ['controller', 'runtime controller', 'runtime-controller'],
  ['agent', 'runtime agent', 'runtime-agent'],
  ['git', 'git service', 'git-service'],
  ['provider', 'runtime provider', 'runtime-provider-service'],
  ['tunnel', 'tunnel broker', 'tunnel-broker'],
].map(([suffix, name, pkg]) => ({ key: `rust-check-${suffix}`, label: `public-rust-check-${suffix}`, name: `Rust check ${name}`, pkg }));
const suites = [
  ['contracts', 'runtime contracts', 'runtime-contracts'],
  ['agent', 'runtime agent', 'runtime-agent'],
  ['proxy', 'OpenAI proxy', 'openai-proxy-server'],
  ['origin', 'origin server', 'origin-http-server'],
  ['git', 'git service', 'git-service'],
].map(([suffix, name, pkg]) => ({ key: `rust-test-${suffix}`, label: `public-rust-test-${suffix}`, name: `Rust test ${name}`, pkg }));
const aggregates = [
  { key: 'rust', label: 'public-rust-check-aggregate', name: 'Rust packages', children: checks },
  { key: 'rust-tests', label: 'public-rust-test-aggregate', name: 'Rust tests', children: suites },
];
const children = [...checks, ...suites], jobs = [...aggregates, ...children];
function job(key) {
  const start = source.indexOf(`\n  ${key}:\n`);
  assert.ok(start >= 0, `missing Rust job ${key}`);
  return source.slice(start + 1).split(/\n  [\w-]+:\n/u)[0];
}
function step(key, name) {
  const text = job(key), marker = `      - name: ${name}\n`, start = text.indexOf(marker);
  assert.ok(start >= 0, `missing ${key}/${name}`);
  const end = text.indexOf('\n      - name: ', start + marker.length);
  return text.slice(start, end < 0 ? text.length : end);
}
function program(key, name) {
  const match = step(key, name).match(/          node <<'NODE'\n([\s\S]*?)          NODE/u);
  assert.ok(match); return match[1].replace(/^          /gmu, '');
}
function context(event) {
  return { repository: 'instafy-dev/instafy', repository_id: '1309636737', run_id: '1001', run_attempt: '1',
    event_name: event, ref: event === 'pull_request' ? 'refs/pull/2/merge' : 'refs/heads/main', ref_protected: event !== 'pull_request',
    event: { repository: { private: true }, ...(event === 'pull_request' ? { pull_request: {
      base: { ref: 'main', repo: { full_name: 'instafy-dev/instafy' } },
      head: { repo: { full_name: 'instafy-dev/instafy', fork: false } },
    } } : {}) } };
}
function route(key, github, enabled = '') {
  const expression = job(key).match(/^    runs-on: >-\n((?:      .*\n)+)/mu)?.[1].trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, '');
  assert.ok(expression);
  assert.doesNotMatch(expression, /matrix\.|inputs\.|github\.job|CI_EXPANDED_SELF_HOSTED|CI_JAVASCRIPT_SELF_HOSTED/u);
  // GitHub expression string equality is case-insensitive; this evaluates the
  // literal workflow expression, not a separately maintained routing model.
  const evaluated = expression.replace(/([a-zA-Z][\w.]*) == ('[^']*'|true|false|[a-zA-Z][\w.]*)/gu, 'equal($1, $2)');
  const selected = vm.runInNewContext(evaluated, {
    github, vars: { CI_RUST_SELF_HOSTED: enabled, CI_EXPANDED_SELF_HOSTED: 'true', CI_JAVASCRIPT_SELF_HOSTED: 'true', CI_BOOTSTRAP_SELF_HOSTED: 'true', CI_RUNNER_MODE: 'self-hosted' },
    equal: (a, b) => typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b,
    fromJSON: JSON.parse,
    format: (text, ...values) => text.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === '{{' ? '{' : match === '}}' ? '}' : String(values[index])),
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(selected));
}

test('both existing Rust contexts are strict five-minute aggregates over every fixed child', () => {
  for (const item of aggregates) {
    const text = job(item.key);
    assert.match(text, new RegExp(`^    name: ${item.name}$`, 'mu'));
    const needs = text.match(/    needs:\n((?:      - .+\n)+)/u)?.[1].trim().split('\n').map(line => line.trim().slice(2));
    assert.deepEqual(needs, item.children.map(child => child.key));
    assert.ok(text.includes(aggregateIf + '\n'));
    assert.match(text, /^    timeout-minutes: 5$/mu);
    assert.match(text, /^    permissions: \{\}$/mu);
    assert.match(text, /RUST_RESULTS: \$\{\{ toJSON\(needs\) \}\}/u);
    assert.doesNotMatch(text, /uses:|checkout|continue-on-error|secrets\.|environment:|fetch\(/u);
  }
});

test('the actual inline aggregates reject every failed, cancelled, skipped, missing and unknown child', () => {
  for (const item of aggregates) {
    const source = program(item.key, 'Require every Rust lane to succeed');
    const success = Object.fromEntries(item.children.map(child => [child.key, { result: 'success', outputs: {} }]));
    const check = value => vm.runInNewContext(source, {
      require: name => { assert.equal(name, 'node:assert/strict'); return assert; },
      process: { env: { RUST_RESULTS: JSON.stringify(value) } }, console: { log() {} },
    }, { timeout: 1000 });
    assert.doesNotThrow(() => check(success));
    for (const child of item.children) {
      for (const result of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', '', 'Success', null]) {
        assert.throws(() => check({ ...success, [child.key]: { result } }), `${child.key}/${result}`);
      }
      const missing = { ...success }; delete missing[child.key]; assert.throws(() => check(missing));
      assert.throws(() => check({ ...success, [child.key]: {} }));
      assert.throws(() => check({ ...success, [child.key]: null }));
    }
    for (const malformed of [{}, [], null, { ...success, unexpected: { result: 'success' } }]) assert.throws(() => check(malformed));
  }
});

test('all twelve selectors are independently default-off and preserve the Ubuntu hosted fallback', () => {
  assert.equal((source.match(/vars\.CI_RUST_SELF_HOSTED/g) ?? []).length, 12);
  const labels = new Set();
  for (const item of jobs) for (const event of ['pull_request', 'push']) {
    const github = context(event), trust = event === 'pull_request' ? 'pr' : 'main';
    for (const toggle of ['', 'false', '0', 'self-hosted', 'unknown', ' true', 'true\n']) assert.equal(route(item.key, github, toggle), 'ubuntu-latest');
    for (const toggle of ['true', 'TRUE']) assert.deepEqual(route(item.key, github, toggle), {
      group: `org/instafy-ci-${trust}`,
      labels: ['self-hosted', 'Linux', 'ARM64', `instafy-ci-bootstrap-1309636737-1001-1-${item.label}`, `instafy-ci-trust-${trust}`],
    });
    labels.add(route(item.key, github, 'true').labels[3]);
    for (const field of ['repository_id', 'run_id', 'run_attempt']) {
      assert.notEqual(route(item.key, { ...github, [field]: '2002' }, 'true').labels[3], route(item.key, github, 'true').labels[3]);
    }
  }
  assert.equal(labels.size, 12);
});

test('public visibility, forks, unrelated repositories and unsupported events cannot select a self-hosted Rust job', () => {
  for (const item of jobs) {
    for (const event of ['workflow_dispatch', 'pull_request_target', 'merge_group', 'schedule', 'workflow_run', 'release']) {
      assert.equal(route(item.key, context(event), 'true'), 'ubuntu-latest');
    }
    for (const event of ['push', 'pull_request']) for (const mutate of [
      g => { g.repository = 'someone/instafy'; }, g => { g.event.repository.private = false; },
      ...(event === 'pull_request' ? [g => { g.event.pull_request.base.ref = 'topic'; },
        g => { g.event.pull_request.head.repo.fork = true; }, g => { g.event.pull_request.head.repo.full_name = 'someone/instafy'; },
        g => { g.event.pull_request.base.repo.full_name = 'someone/instafy'; }] : [g => { g.ref = 'refs/heads/topic'; }, g => { g.ref_protected = false; }]),
    ]) { const github = context(event); mutate(github); assert.equal(route(item.key, github, 'true'), 'ubuntu-latest'); }
  }
});

test('ten bounded children independently check out exact source and retain native stable Rust', () => {
  for (const item of children) {
    const text = job(item.key);
    assert.match(text, new RegExp(`^    name: ${item.name}$`, 'mu'));
    assert.match(text, /^    timeout-minutes: 30$/mu);
    assert.doesNotMatch(text, /^    (?:if|needs|strategy|environment|defaults):|continue-on-error|secrets\./mu);
    assert.match(text, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u);
    assert.match(text, /submodules: recursive/u);
    assert.match(text, /persist-credentials: false/u);
    assert.match(text, /ref: \$\{\{ github\.sha \}\}/u);
    assert.match(text, /CARGO_PROFILE_DEV_DEBUG: "0"/u);
    assert.match(text, /CARGO_TARGET_DIR: \$\{\{ github\.workspace \}\}\/\.cargo-target/u);
    const setup = step(item.key, 'Set up stable Rust');
    assert.match(setup, /run: \|\n          rustup toolchain install stable --profile minimal\n          rustup default stable\n/u);
    assert.doesNotMatch(setup, /if:|working-directory:|continue-on-error|--target/u);
    assert.match(text, /run: node --test scripts\/check-rust-ci\.test\.mjs/u);
    assert.ok(text.indexOf('Qualify isolated Rust CI runner') < text.indexOf('Checkout repository'));
    assert.ok(fs.existsSync(path.join(root, 'packages', item.pkg, 'Cargo.toml')));
    assert.ok(fs.existsSync(path.join(root, 'packages', item.pkg, 'Cargo.lock')));
  }
});

test('only self-hosted Rust children install the fixed missing native packages within the original thirty-minute job', () => {
  assert.equal((source.match(/      - name: Install scoped Rust native prerequisites/g) ?? []).length,10);
  const commands=[];
  for(const item of children){
    const text=job(item.key),install=step(item.key,'Install scoped Rust native prerequisites');
    assert.match(install,/^        if: runner\.environment == 'self-hosted'$/mu);
    assert.match(install,/^        timeout-minutes: 5$/mu);assert.match(text,/^    timeout-minutes: 30$/mu);
    assert.match(install,/^        shell: bash$/mu);assert.match(install,/set -euo pipefail/u);
    assert.match(install,/sudo -n apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update/u);
    assert.match(install,/sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install --yes --no-install-recommends clang lld cmake libcap-dev protobuf-compiler/u);
    assert.equal((install.match(/DPkg::Lock::Timeout=120/g) ?? []).length,1);
    assert.doesNotMatch(install,/kill|systemctl|rm .*lock|DPkg::Lock::Timeout=-1/u);
    assert.match(install,/for package in clang lld cmake libcap-dev protobuf-compiler; do/u);
    assert.match(install,/dpkg-query --show --showformat='\$\{Status\}'/u);assert.match(install,/pkg-config --exists libcap/u);
    for(const tool of ['clang','ld.lld','cmake','protoc'])assert(install.includes(`          ${tool} --version\n`));
    assert.doesNotMatch(install,/continue-on-error|\|\| true|AllowUnauthenticated|Verify-Peer|Verify-Host|apt-key|add-apt-repository|curl|https?:\/\//u);
    assert(text.indexOf('Install scoped Rust native prerequisites')<text.indexOf('Set up stable Rust'));
    commands.push(install);
  }
  assert.equal(new Set(commands).size,1);
  for(const item of aggregates)assert.doesNotMatch(job(item.key),/apt-get|Install scoped Rust native prerequisites/u);
});

test('the full original five check and six test commands and working directories are hash-bound', () => {
  // Exact normalized command order + working-directory from build.yml at f20002b.
  // Commands are literal steps, not a matrix/shell fragment that can drop a crate.
  for (const [list, stepName, hash, expectedCount] of [
    [checks, 'Check public Rust package', '555d7092d19a4cc330abb80fa5dc6c1a8785b916a0119adcc2fdfc2741e678ff', 5],
    [suites, 'Run database-free Rust test suite', '6ad118442a26d37edb764ab17c0098c40f9c199e8f4963fcdcb8e94faccc65aa', 6],
  ]) {
    const inventory = list.flatMap(item => {
      const part = step(item.key, stepName);
      assert.doesNotMatch(part, /^        (?:if|continue-on-error|timeout-minutes|env|shell):/mu);
      assert.match(part, /        run: \|\n/u);
      const afterRun = part.replace(agentLinkerDefault, '').split('        run: |\n')[1];
      const block = afterRun.match(/^(?:          .*(?:\n|$))+/u)?.[0];
      assert.ok(block);
      // A following job's top-level comment is not part of this YAML block.
      // Reject other trailing text instead of filtering away an added command.
      assert.ok(afterRun.slice(block.length).split('\n').every(line => !line.trim() || /^  #/u.test(line)));
      const run = block.trimEnd().split('\n').map(line => line.slice(10));
      const workingDirectory = part.match(/^        working-directory: (.*)$/mu)?.[1] ?? null;
      return run.map(command => ({ run: command, workingDirectory }));
    });
    assert.equal(inventory.length, expectedCount);
    assert.equal(createHash('sha256').update(JSON.stringify(inventory)).digest('hex'), hash);
  }
  assert.equal(children.reduce((sum, item) => sum + (job(item.key).match(/^          cargo (?:check|test) /gmu) ?? []).length, 0), 11);
  const agent = step('rust-test-agent', 'Run database-free Rust test suite');
  assert.match(agent, /--no-run\n          cargo test .* --lib --test controller_client -- --test-threads=1/u);
});

test('test children preserve unfiltered frozen Node20 installation and host-only disk cleanup', () => {
  for (const item of suites) {
    const text = job(item.key);
    assert.match(text, /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1/u);
    assert.match(text, /node-version: "20"/u);
    const install = step(item.key, 'Install dependencies');
    assert.match(install, /run: pnpm install --frozen-lockfile\n/u);
    assert.doesNotMatch(install, /if:|--ignore-scripts|--filter|continue-on-error/u);
    const disk = step(item.key, 'Free runner disk space');
    assert.match(disk, /if: runner\.environment == 'github-hosted'/u);
    assert.match(disk, /sudo rm -rf \/usr\/share\/dotnet \/usr\/local\/lib\/android \/opt\/ghc \/opt\/hostedtoolcache\/CodeQL\n          df -h \//u);
  }
  for (const item of checks) assert.doesNotMatch(job(item.key), /pnpm install|Free runner disk space/u);
});

test('only the runtime-agent Cargo step defaults self-hosted Linux linking, with no job-wide environment mutation', () => {
  const agent = step('rust-test-agent', 'Run database-free Rust test suite');
  assert.equal(source.split(agentLinkerDefault).length, 2);
  assert.ok(agent.includes(agentLinkerDefault));
  assert.doesNotMatch(agent, /GITHUB_ENV|GITHUB_OUTPUT|continue-on-error|linker=clang|\|\| true/u);
  for (const item of children.filter(item => item.key !== 'rust-test-agent')) assert.ok(!job(item.key).includes(agentLinkerDefault));
  assert.ok(step('rust-test-agent', 'Install scoped Rust native prerequisites').includes('ld.lld --version'));
});

test('actual runtime-agent Bash defaults only unset flags on self-hosted Linux and preserves both Cargo invocations', () => {
  const script = step('rust-test-agent', 'Run database-free Rust test suite').split('        run: |\n')[1]
    .trimEnd().split('\n').map(line => line.slice(10)).join('\n');
  const expression = "${{ runner.environment == 'self-hosted' && runner.os == 'Linux' }}";
  assert.equal(script.split(expression).length, 2);
  const commands = [
    ['test', '--manifest-path', 'packages/runtime-agent/Cargo.toml', '--no-run'],
    ['test', '--manifest-path', 'packages/runtime-agent/Cargo.toml', '--lib', '--test', 'controller_client', '--', '--test-threads=1'],
  ];
  const fixture = `cargo() { printf 'CALL\\0%s\\0%s\\0' "\${RUSTFLAGS+x}" "\${RUSTFLAGS-}"; printf '%s\\0' "$@"; return "\${CARGO_FIXTURE_STATUS:-0}"; }\n`;
  for (const environment of ['self-hosted', 'github-hosted', '', 'unknown']) for (const os of ['Linux', 'macOS', 'Windows', '']) {
    const selected = vm.runInNewContext("runner.environment == 'self-hosted' && runner.os == 'Linux'", { runner: { environment, os } });
    for (const flags of [undefined, '', '-C opt-level=1', '  -C target-cpu=native  ', '$(false);\nINERT_CHOICE']) {
      const env = { PATH: '/usr/bin:/bin', ...(flags === undefined ? {} : { RUSTFLAGS: flags }) };
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', fixture + script.replace(expression, String(selected))], { env, timeout:5000 });
      assert.equal(result.status,0);assert.equal(result.stderr.toString(),'');
      const expected = flags === undefined && selected ? '-C link-arg=-fuse-ld=lld' : flags;
      const tokens = result.stdout.toString().split('\0');tokens.pop();
      assert.deepEqual(tokens, commands.flatMap(args => ['CALL', expected === undefined ? '' : 'x', expected ?? '', ...args]));
      assert.deepEqual(env, { PATH: '/usr/bin:/bin', ...(flags === undefined ? {} : { RUSTFLAGS: flags }) });
    }
  }
  const failed = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', fixture + script.replace(expression, 'true')], {
    env: { PATH: '/usr/bin:/bin', CARGO_FIXTURE_STATUS: '7' }, timeout:5000,
  });
  assert.equal(failed.status,7);assert.equal(failed.stderr.toString(),'');
  assert.equal(failed.stdout.toString().split('CALL').length,2);
});

test('cargo caches cannot cross OS, CPU architecture, crate lane or lockfile inventory', () => {
  for (const item of children) {
    for (const name of ['Restore cargo cache', 'Restore cargo cache without saving']) {
      const cache = step(item.key, name);
      assert.ok(cache.includes(`key: rust-ci-v3-\${{ runner.os }}-\${{ runner.arch }}-${item.label}-\${{ hashFiles('packages/*/Cargo.lock') }}`));
      assert.match(cache, /~\/\.cargo\/registry\n            ~\/\.cargo\/git\n            \.cargo-target/u);
      assert.doesNotMatch(cache, /restore-keys:|rust-tests-v2|enableCrossOsArchive/u);
    }
  }
});

test('only self-hosted Rust children use restore-only caches while hosted saves remain intact', () => {
  const pin = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
  for (const item of children) {
    const restore = step(item.key, 'Restore cargo cache without saving');
    const hosted = step(item.key, 'Restore cargo cache');
    assert.match(restore, /^        if: runner\.environment == 'self-hosted'$/mu);
    assert.match(hosted, /^        if: runner\.environment == 'github-hosted'$/mu);
    assert.ok(restore.includes(`        uses: actions/cache/restore@${pin} # v6.1.0\n`));
    assert.ok(hosted.includes(`        uses: actions/cache@${pin} # v6.1.0\n`));
    assert.equal(restore.split('        with:\n')[1], hosted.split('        with:\n')[1]);
    assert.equal((job(item.key).match(/uses: actions\/cache(?:\/\w+)?@/gu) ?? []).length, 2);
    assert.doesNotMatch(job(item.key), /actions\/cache\/save@|continue-on-error|save-always|lookup-only/u);
    const enabled = (text, environment) => vm.runInNewContext(
      text.match(/^        if: (.+)$/mu)[1], { runner: { environment } }, { timeout: 1000 });
    for (const environment of ['self-hosted', 'github-hosted', '', 'unknown']) {
      assert.equal(enabled(restore, environment), environment === 'self-hosted');
      assert.equal(enabled(hosted, environment), environment === 'github-hosted');
    }
    const cargoStep = item.key.startsWith('rust-check-') ? 'Check public Rust package' : 'Run database-free Rust test suite';
    assert.ok(job(item.key).indexOf(restore) < job(item.key).indexOf(step(item.key, cargoStep)));
  }
  assert.equal((source.match(/uses: actions\/cache\/restore@/gu) ?? []).length, 10);
});

test('the restore-only mitigation preserves every other byte of the reviewed Build workflow', () => {
  assert.equal((source.match(/ -o DPkg::Lock::Timeout=120/g) ?? []).length,10);
  // Undo only the separately tested cancelled-main aggregate guards as well.
  let normalized = source.replaceAll(aggregateIf, '    if: ${{ always() }}')
    .replaceAll(' -o DPkg::Lock::Timeout=120','').replace(agentLinkerDefault, '');
  for (const item of children) {
    const restore = step(item.key, 'Restore cargo cache without saving');
    const hosted = step(item.key, 'Restore cargo cache');
    normalized = normalized.replace(restore + '\n', '').replace(hosted,
      hosted.replace("        if: runner.environment == 'github-hosted'\n", ''));
  }
  // Full build.yml at the reviewed combined source 2ef4dde: includes all original
  // functional commands, aggregate guards, routing, permissions and other jobs.
  assert.equal(createHash('sha256').update(normalized).digest('hex'),
    'cfbf699d139a325d9d2add3add71ec8d3db4d4ca737925bc3963871706d7fa4a');
});

test('actual inline runner qualification rejects wrong native identity, ambient private env and missing compilers', () => {
  for (const item of jobs) {
    const source = program(item.key, 'Qualify isolated Rust CI runner');
    const evaluate = (override = {}, missing) => {
      const tools = [];
      vm.runInNewContext(source, { process: { platform: 'linux', arch: 'arm64', getuid: () => 503, versions: { node: '22.23.2' },
        env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'ARM64', INSTAFY_CI_JOB_ISOLATION: 'ephemeral' }, ...override },
        require: name => name === 'node:assert/strict' ? assert : { execFileSync(file, args, options) {
          assert.equal(file, '/bin/bash'); assert.equal(args[0], '-c'); assert.equal(args[1], 'command -v "$1" >/dev/null');
          assert.equal(options.timeout, 1000); assert.equal(options.stdio, 'ignore');
          const tool = args.at(-1); if (tool === missing) throw Error('missing tool'); tools.push(tool);
        } },
      }, { timeout: 1000 }); return tools;
    };
    assert.doesNotThrow(() => evaluate());
    for (const override of [{ platform: 'darwin' }, { arch: 'x64' }, { getuid: () => 0 }, { versions: { node: '20.20.2' } }, { env: {} },
      { env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'ARM64', INSTAFY_CI_JOB_ISOLATION: 'ephemeral', INSTAFY_ENV_DIR: '/inert' } }]) assert.throws(() => evaluate(override));
    if (children.includes(item)) for (const tool of ['rustup', 'cargo', 'cc', 'pkg-config', 'make']) {
      assert.ok(evaluate().includes(tool)); assert.throws(() => evaluate({}, tool));
    }
  }
});

test('the split does not change other workflow gates, triggers, privileges or Rust formatting', () => {
  const keys = source.match(/^  [\w-]+:$/gmu).map(line => line.trim().slice(0, -1));
  assert.deepEqual(keys.filter(key => key.startsWith('rust')).sort(), [...jobs.map(item => item.key), 'rust-fmt'].sort());
  assert.match(source, /^on:\n  pull_request:\n  push:\n    branches:\n      - main\n  workflow_dispatch:/mu);
  assert.match(source, /^permissions:\n  contents: read$/mu);
  assert.match(job('rust-fmt'), /vars\.CI_EXPANDED_SELF_HOSTED == 'true'/u);
  assert.doesNotMatch(job('rust-fmt'), /CI_RUST_SELF_HOSTED/u);
  assert.match(job('rust-fmt'), /cargo fmt --all --manifest-path "\$manifest" --check/u);
  assert.match(job('browser-verification'), /uses: \.\/\.github\/workflows\/browser-e2e\.yml/u);
  for (const item of jobs) assert.doesNotMatch(job(item.key), /cancel-in-progress:|strategy:|matrix\.|workflow_dispatch:|secrets\.|deploy|publish|DOCKER|DATABASE_URL/u);
});
