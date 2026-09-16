import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
const aggregateIf = "    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}";
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
    assert.ok(text.startsWith(`  ${item.key}:\n    name: ${item.name}\n    runs-on: ubuntu-latest\n`));
    assert.doesNotMatch(text, /runner\.environment|self-hosted|Qualify isolated|apt-get|RUSTFLAGS/u);
    assert.ok(fs.existsSync(path.join(root, 'packages', item.pkg, 'Cargo.toml')));
    assert.ok(fs.existsSync(path.join(root, 'packages', item.pkg, 'Cargo.lock')));
  }
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
      const afterRun = part.split('        run: |\n')[1];
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
    assert.doesNotMatch(disk, /if:/u);
    assert.match(disk, /sudo rm -rf \/usr\/share\/dotnet \/usr\/local\/lib\/android \/opt\/ghc \/opt\/hostedtoolcache\/CodeQL\n          df -h \//u);
  }
  for (const item of checks) assert.doesNotMatch(job(item.key), /pnpm install|Free runner disk space/u);
});

test('cargo caches cannot cross OS, CPU architecture, crate lane or lockfile inventory', () => {
  for (const item of children) {
    const cache = step(item.key, 'Restore cargo cache');
    assert.ok(cache.includes(`key: rust-ci-v3-\${{ runner.os }}-\${{ runner.arch }}-${item.label}-\${{ hashFiles('packages/*/Cargo.lock') }}`));
    assert.match(cache, /~\/\.cargo\/registry\n            ~\/\.cargo\/git\n            \.cargo-target/u);
    assert.doesNotMatch(cache, /restore-keys:|rust-tests-v2|enableCrossOsArchive|if:/u);
    // One unconditional save+restore cache per child; no restore-only mitigation remains.
    assert.ok(cache.includes('        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n'));
    assert.equal((job(item.key).match(/uses: actions\/cache(?:\/\w+)?@/gu) ?? []).length, 1);
    assert.doesNotMatch(job(item.key), /actions\/cache\/(?:restore|save)@|continue-on-error|save-always|lookup-only/u);
  }
});

test('the split does not change other workflow gates, triggers, privileges or Rust formatting', () => {
  const keys = source.match(/^  [\w-]+:$/gmu).map(line => line.trim().slice(0, -1));
  assert.deepEqual(keys.filter(key => key.startsWith('rust')).sort(), [...jobs.map(item => item.key), 'rust-fmt'].sort());
  assert.match(source, /^on:\n  pull_request:\n  push:\n    branches:\n      - main\n  workflow_dispatch:/mu);
  assert.match(source, /^permissions:\n  contents: read$/mu);
  assert.match(job('rust-fmt'), /^    runs-on: ubuntu-latest$/mu);
  assert.match(job('rust-fmt'), /cargo fmt --all --manifest-path "\$manifest" --check/u);
  for (const item of aggregates) assert.match(job(item.key), /^    runs-on: ubuntu-latest$/mu);
  assert.match(job('browser-verification'), /uses: \.\/\.github\/workflows\/browser-e2e\.yml/u);
  for (const item of jobs) assert.doesNotMatch(job(item.key), /cancel-in-progress:|strategy:|matrix\.|workflow_dispatch:|secrets\.|deploy|publish|DOCKER|DATABASE_URL/u);
});
