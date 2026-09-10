import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const jobs = [
  { file: 'controller-db-tests.yml', key: 'controller-db-tests', label: 'public-controller-db', name: 'Controller database tests', minutes: 30 },
  { file: 'auth-email.yml', key: 'auth-email', label: 'public-auth-email', name: 'signup -> email -> activate', minutes: 25 },
];
const source = job => fs.readFileSync(path.join(root, '.github/workflows', job.file), 'utf8');
function step(job, name) {
  const text = source(job), marker = `      - name: ${name}\n`, start = text.indexOf(marker);
  assert.ok(start >= 0, `missing ${job.file}/${name}`);
  const end = text.indexOf('\n      - name: ', start + marker.length);
  return text.slice(start, end < 0 ? text.length : end);
}
function context(event) {
  return { repository: 'instafy-dev/instafy', repository_id: '1309636737', run_id: '1001', run_attempt: '2',
    event_name: event, ref: event === 'pull_request' ? 'refs/pull/3/merge' : 'refs/heads/main', ref_protected: event !== 'pull_request',
    event: { repository: { private: true }, ...(event === 'pull_request' ? { pull_request: {
      base: { ref: 'main', repo: { full_name: 'instafy-dev/instafy' } },
      head: { repo: { full_name: 'instafy-dev/instafy', fork: false } },
    } } : {}) } };
}
function select(job, github, enabled = '') {
  const expression = source(job).match(/^    runs-on: >-\n((?:      .*\n)+)/mu)?.[1].trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, '');
  assert.ok(expression);
  assert.doesNotMatch(expression, /github\.job|matrix\.|inputs\./u);
  const selected = vm.runInNewContext(expression.replace(/([a-zA-Z][\w.]*) == ('[^']*'|true|false|[a-zA-Z][\w.]*)/gu, 'equal($1, $2)'), {
    github, vars: { CI_DATABASE_SELF_HOSTED: enabled, CI_RUNNER_MODE: 'self-hosted', CI_BOOTSTRAP_SELF_HOSTED: 'true',
      CI_EXPANDED_SELF_HOSTED: 'true', CI_JAVASCRIPT_SELF_HOSTED: 'true', CI_RUST_SELF_HOSTED: 'true' },
    equal: (a, b) => typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b,
    fromJSON: JSON.parse,
    format: (value, ...args) => value.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === '{{' ? '{' : match === '}}' ? '}' : String(args[index])),
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(selected));
}

test('database routing is independently default-off and binds each exact run, attempt and job', () => {
  for (const job of jobs) for (const event of ['pull_request', 'push']) {
    const github = context(event), trust = event === 'push' ? 'main' : 'pr';
    for (const value of ['', 'false', '0', 'self-hosted', 'unknown', ' true', 'true\n']) assert.equal(select(job, github, value), 'ubuntu-latest');
    for (const value of ['true', 'TRUE']) assert.deepEqual(select(job, github, value), {
      group: `org/instafy-ci-${trust}`,
      labels: ['self-hosted', 'Linux', 'ARM64', `instafy-ci-bootstrap-1309636737-1001-2-${job.label}`, `instafy-ci-trust-${trust}`],
    });
    for (const field of ['repository_id', 'run_id', 'run_attempt']) {
      assert.notEqual(select(job, { ...github, [field]: '999' }, 'true').labels[3], select(job, github, 'true').labels[3]);
    }
  }
  assert.notEqual(select(jobs[0], context('push'), 'true').labels[3], select(jobs[1], context('push'), 'true').labels[3]);
});

test('public repositories, forks, unprotected refs and unsupported events stay hosted', () => {
  for (const job of jobs) {
    for (const event of ['workflow_dispatch', 'merge_group', 'pull_request_target', 'schedule', 'workflow_run', 'release']) {
      assert.equal(select(job, context(event), 'true'), 'ubuntu-latest');
    }
    for (const event of ['pull_request', 'push']) for (const mutate of [
      g => { g.repository = 'other/repo'; }, g => { g.event.repository.private = false; },
      ...(event === 'pull_request' ? [g => { g.event.pull_request.base.ref = 'topic'; },
        g => { g.event.pull_request.base.repo.full_name = 'other/repo'; },
        g => { g.event.pull_request.head.repo.full_name = 'other/repo'; }, g => { g.event.pull_request.head.repo.fork = true; }]
        : [g => { g.ref = 'refs/heads/topic'; }, g => { g.ref_protected = false; }]),
    ]) {
      const github = context(event); mutate(github); assert.equal(select(job, github, 'true'), 'ubuntu-latest');
    }
    const pr = context('pull_request'); pr.ref = 'refs/heads/main'; pr.ref_protected = true;
    assert.equal(select(job, pr, 'true').group, 'org/instafy-ci-pr');
  }
});

test('only two unchanged check identities opt in, with existing timeouts and read-only source access', () => {
  for (const file of fs.readdirSync(path.join(root, '.github/workflows')).filter(name => /\.ya?ml$/u.test(name))) {
    const value = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    assert.equal((value.match(/vars\.CI_DATABASE_SELF_HOSTED/g) ?? []).length, jobs.filter(job => job.file === file).length);
  }
  for (const job of jobs) {
    const text = source(job);
    assert.ok(text.includes(`\n  ${job.key}:\n    name: ${job.name}\n`));
    assert.match(text, new RegExp(`^    timeout-minutes: ${job.minutes}$`, 'mu'));
    assert.match(text, /^permissions:\n  contents: read$/mu);
    assert.match(text, /cancel-in-progress: true/u);
    assert.doesNotMatch(text, /secrets\.|continue-on-error|environment:|permissions:.*write|\bneeds:|strategy:/u);
    assert.match(step(job, 'Checkout repository'), /persist-credentials: false\n          ref: \$\{\{ github\.sha \}\}/u);
    assert.match(text, /node-version: "20"\n          cache: "pnpm"/u);
    assert.match(text, /scripts\/check-database-ci-routing\.test\.mjs/u);
    assert.match(step(job, 'Verify database CI routing contracts'), /run: node --test scripts\/check-database-ci-routing\.test\.mjs/u);
    assert.match(step(job, 'Stop local Supabase'), /if: always\(\)\n        run: pnpm supabase:down \|\| true/u);
    assert.doesNotMatch(step(job, 'Install dependencies'), /--ignore-scripts|--filter/u);
  }
  assert.match(step(jobs[0], 'Checkout repository'), /submodules: recursive/u);
  assert.doesNotMatch(step(jobs[1], 'Checkout repository'), /submodules:/u);
});

test('all original workload commands retain exact bytes, full test coverage and local stack modes', () => {
  // SHA256 of run text from e9da3af6, excluding adjacent comments, not merely a substring check.
  const sharedInstall = '96929d7007ed95509cb2d28e4f6bfbf07f665e0b6cfbf51f3605fbca56b068ce';
  const up = 'c9b184b6ad4a16effe3188e1b0cac0af822017701bc637558af03906503b01ab';
  const down = '772ea972c99c56cb90b0c78df36d9f4a16b7745369b4710b5f3481d0a40174f3';
  const inventories = [
    { 'Set up stable Rust': 'd7910daeee1055bac7de36f01d2e2e0657002cdc973b046a310bf2f7ad849218',
      'Install dependencies': sharedInstall, 'Start Supabase Postgres and apply migrations': up,
      'Run controller test suite': 'fbf5457a646d4a9bdc56723325bc01db34be405a34b7026b1d3d31955d0ef719' },
    { 'Install dependencies': sharedInstall, 'Verify Supabase CLI': 'b9726eed7f00409ea9e0ccc51796b09d43b0e7ee3213adadcbb4d7926f1d61ed',
      'Ensure no stale Supabase stack': down, 'Start local Supabase (GoTrue + mail catcher)': up,
      'Run auth email smoke (signup -> email -> activate)': '8a9431ec0d2a8f1e46471aac749a077c9bf08345fa3b25f421d53c11939d0a52', 'Stop local Supabase': down },
  ];
  for (const [index, inventory] of inventories.entries()) for (const [name, expected] of Object.entries(inventory)) {
    const text = step(jobs[index], name), tail = text.slice(text.indexOf('\n        run:'));
    const run = tail.split('\n').filter((line, n) => n === 0 || line.startsWith('        run:') || line.startsWith('          ')).join('\n').trim();
    assert.equal(createHash('sha256').update(run).digest('hex'), expected, `${jobs[index].key}/${name}`);
  }
  assert.match(step(jobs[0], 'Start Supabase Postgres and apply migrations'), /SUPABASE_DATABASE_ONLY: "1"/u);
  assert.match(source(jobs[0]), /TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres/u);
  assert.doesNotMatch(source(jobs[1]), /SUPABASE_DATABASE_ONLY|--exclude|--ignore-health-check/u);
});

test('Auth opts into only the fixed five-service profile and changes to either helper trigger its complete workload', () => {
  assert.match(step(jobs[1], 'Start local Supabase (GoTrue + mail catcher)'), /env:\n          SUPABASE_AUTH_ONLY: "1"\n        run: pnpm supabase:up/u);
  assert.equal((source(jobs[1]).match(/SUPABASE_AUTH_ONLY/g) ?? []).length, 1);
  assert.doesNotMatch(source(jobs[0]), /SUPABASE_AUTH_ONLY/u);
  for (const file of ['scripts/lib/supabaseStartMode.mjs', 'scripts/lib/supabaseStartMode.test.mjs',
    'scripts/lib/supabaseSerialPull.mjs', 'scripts/lib/supabaseSerialPull.test.mjs']) {
    for (const trigger of ['pull_request', 'push']) {
      const block = source(jobs[1]).split(`  ${trigger}:\n`)[1].split(/^  \w/mu)[0];
      assert.ok(block.includes(`      - "${file}"`), `${trigger} must include ${file}`);
    }
  }
});

function preflight(job, mutate = () => {}, missing) {
  const text = step(job, 'Qualify isolated database CI runner');
  assert.match(text, /if: runner.environment == 'self-hosted'\n        shell: bash/u);
  assert.ok(source(job).indexOf(text) < source(job).indexOf('      - name: Checkout repository'));
  const program = text.match(/          node <<'NODE'\n([\s\S]*?)          NODE/u)?.[1].replace(/^          /gmu, '');
  assert.ok(program);
  const state = { process: { platform: 'linux', arch: 'arm64', getuid: () => 503, versions: { node: '22.23.2' },
    env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'ARM64', INSTAFY_CI_JOB_ISOLATION: 'ephemeral' } }, engine: { OSType: 'linux', Architecture: 'aarch64' } };
  mutate(state); const calls = [];
  vm.runInNewContext(program, { process: state.process, require(name) {
    if (name === 'node:assert/strict') return assert;
    assert.equal(name, 'node:child_process');
    return { execFileSync(file, args, options) {
      calls.push({ file, args: Array.from(args) });
      if (file === '/bin/bash') { assert.equal(options.timeout, 1000); if (args[3] === missing) throw Error('tool missing'); }
      else if (file === 'pkg-config') { assert.deepEqual(Array.from(args), ['--exists', 'openssl']); if (missing === 'openssl') throw Error('OpenSSL missing'); }
      else { assert.equal(file, 'docker'); assert.deepEqual(Array.from(args), ['info', '--format', '{{json .}}']); assert.equal(options.timeout, 10000); return JSON.stringify(state.engine); }
      return '';
    } };
  } }, { timeout: 1000 });
  return calls;
}

test('native preflight checks actual template tools and the real ARM Docker engine before checkout', () => {
  for (const job of jobs) {
    const tools = ['bash', 'git', 'curl', 'tar', 'sha256sum', 'unzip', 'docker',
      ...(job.key === 'controller-db-tests' ? ['rustup', 'cc', 'c++', 'make', 'pkg-config'] : [])];
    assert.deepEqual(preflight(job).filter(call => call.file === '/bin/bash').map(call => call.args[3]), tools);
    for (const tool of tools) assert.throws(() => preflight(job, undefined, tool));
    for (const mutate of [s => { s.process.platform = 'darwin'; }, s => { s.process.arch = 'x64'; }, s => { s.process.getuid = () => 0; },
      s => { s.process.versions.node = '20.20.2'; }, s => { s.process.env.RUNNER_ARCH = 'X64'; }, s => { s.process.env.RUNNER_OS = 'macOS'; },
      s => { delete s.process.env.INSTAFY_CI_JOB_ISOLATION; }, s => { s.process.env.INSTAFY_ENV_DIR = '/inert'; },
      s => { s.engine.OSType = 'windows'; }, s => { s.engine.Architecture = 'x86_64'; }]) assert.throws(() => preflight(job, mutate));
  }
  assert.throws(() => preflight(jobs[0], undefined, 'openssl'));
  assert.doesNotMatch(source(jobs[0]), /command -v (?:clang|lld|cmake|protoc)|apt-get/u);
});

test('controller resource/cache settings are bounded and never shared across OS, architecture or lockfiles', () => {
  const cache = step(jobs[0], 'Cache controller Cargo dependencies and build');
  assert.match(cache, /actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/u);
  assert.match(cache, /controller-db-\$\{\{ runner.os \}\}-\$\{\{ runner.arch \}\}-\$\{\{ hashFiles\('packages\/runtime-controller\/Cargo.lock'\) \}\}/u);
  assert.doesNotMatch(cache.replace("        if: runner.environment == 'github-hosted'\n", ''),
    /restore-keys:|enableCrossOsArchive|\.env|credentials/u);
  assert.match(source(jobs[0]), /CARGO_BUILD_JOBS: "2"/u);
  assert.doesNotMatch(source(jobs[1]), /rustup|cargo |actions\/cache@|apt-get/u);
  const proto = fs.readFileSync(path.join(root, 'packages/runtime-contracts/build.rs'), 'utf8');
  assert.match(proto, /protoc_bin_vendored::protoc_bin_path\(\)/u);
});

test('self-hosted controller compiler cache restores only and all other workflow bytes remain exact', () => {
  const text = source(jobs[0]);
  const restore = step(jobs[0], 'Restore compiler cache without saving');
  const hosted = step(jobs[0], 'Cache controller Cargo dependencies and build');
  assert.match(restore, /^        if: runner\.environment == 'self-hosted'$/mu);
  assert.match(hosted, /^        if: runner\.environment == 'github-hosted'$/mu);
  assert.match(restore, /^        uses: actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0$/mu);
  assert.match(hosted, /^        uses: actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0$/mu);
  const inputs = value => value.match(/        with:\n(?:          .+\n)+/u)?.[0];
  assert.ok(inputs(restore)); assert.equal(inputs(restore), inputs(hosted));
  for (const environment of ['self-hosted', 'github-hosted', '', 'unknown']) {
    for (const [part, selected] of [[restore, 'self-hosted'], [hosted, 'github-hosted']]) {
      assert.equal(vm.runInNewContext(part.match(/^        if: (.+)$/mu)[1], { runner: { environment } }, { timeout: 1000 }), environment === selected);
    }
  }
  assert.equal((text.match(/uses: actions\/cache(?:\/\w+)?@/gu) ?? []).length, 2);
  assert.doesNotMatch(text, /actions\/cache\/save@|continue-on-error|save-always|lookup-only/u);
  const normalized = text.replace(restore + '\n', '').replace(hosted,
    hosted.replace("        if: runner.environment == 'github-hosted'\n", ''));
  // Complete controller-db-tests.yml at combined source 2ef4dde: same Cargo,
  // migrations, stack lifecycle, permissions, routing and resource limits.
  assert.equal(createHash('sha256').update(normalized).digest('hex'),
    '79ed4285fb5ea6ded4878bb041a26c000f938c848b10412c4e8310db67024c27');
});
