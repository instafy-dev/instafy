import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
const aggregateIf = "    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}";
const lanes = [
  { key: 'javascript-contracts', label: 'public-js-contracts', name: 'JavaScript contracts and migrations' },
  { key: 'javascript-frontend', label: 'public-js-frontend', name: 'JavaScript frontend' },
  { key: 'javascript-cli', label: 'public-js-cli', name: 'JavaScript CLI and provider contract' },
  { key: 'javascript-desktop', label: 'public-js-desktop', name: 'JavaScript Desktop and runtime' },
];
const jobs = [{ key: 'javascript', label: 'public-js-aggregate', name: 'JavaScript packages' }, ...lanes];
function job(key) {
  const start = source.indexOf(`\n  ${key}:\n`);
  assert.ok(start >= 0, `missing JavaScript job ${key}`);
  return source.slice(start + 1).split(/\n  [\w-]+:\n/u)[0];
}
function step(key, name) {
  const text = job(key), marker = `      - name: ${name}\n`, start = text.indexOf(marker);
  assert.ok(start >= 0, `missing ${key}/${name}`);
  const end = text.indexOf('\n      - name: ', start + marker.length);
  return text.slice(start, end < 0 ? text.length : end);
}
function javascript(key, name) {
  const match = step(key, name).match(/          node <<'NODE'\n([\s\S]*?)          NODE/u);
  assert.ok(match);
  return match[1].replace(/^          /gmu, '');
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
  assert.doesNotMatch(expression, /matrix\.|inputs\.|github\.job|CI_EXPANDED_SELF_HOSTED/u);
  const evaluated = expression.replace(/([a-zA-Z][\w.]*) == ('[^']*'|true|false|[a-zA-Z][\w.]*)/gu, 'equal($1, $2)');
  const selected = vm.runInNewContext(evaluated, {
    github, vars: { CI_JAVASCRIPT_SELF_HOSTED: enabled, CI_EXPANDED_SELF_HOSTED: 'true', CI_BOOTSTRAP_SELF_HOSTED: 'true', CI_RUNNER_MODE: 'self-hosted' },
    equal: (a, b) => typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b,
    fromJSON: JSON.parse,
    format: (text, ...values) => text.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === '{{' ? '{' : match === '}}' ? '}' : String(values[index])),
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(selected));
}

// These are source-only cancellation regressions, not a GitHub scheduler test.
// Keep them in this existing CI test entrypoint so no workflow command changes.
const cancellationWorkflows = [
  { file: 'build.yml', text: source, keys: ['javascript', 'rust', 'rust-tests'],
    previousHash: '0c0332d3dc8eeebdd9f68e6fc23b31f145cd5f791017e5f3784e1619f38465bc' },
  { file: 'browser-e2e.yml', text: fs.readFileSync(path.join(root, '.github/workflows/browser-e2e.yml'), 'utf8'),
    keys: ['shared-profile'], previousHash: '71980384b6c935e2fbe90e48cd7526e8bbded8721611cea427ee0f9bd5da1115' },
];
const cancellationAggregates = cancellationWorkflows.flatMap(workflow => workflow.keys.map(key => {
  const text = workflow.text.split('\n  ' + key + ':\n')[1]?.split(/\n  [\w-]+:\n/u)[0];
  assert.ok(text, workflow.file + '/' + key);
  return { key, text };
}));
// GitHub compares unlike types numerically; strings use case-insensitive
// comparison only when BOTH operands are strings. Objects/arrays stay opaque.
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#operators
function actionsEqual(left, right) {
  const type = value => value === null || value === undefined ? 'null' : typeof value;
  if (type(left) === type(right)) {
    if (type(left) === 'null') return true;
    return typeof left === 'string' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }
  const number = value => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return NaN;
    if (value.trim() === '') return 0;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'number' ? parsed : NaN;
    } catch { return NaN; }
  };
  return number(left) === number(right);
}
function aggregateRuns(text, github, isCancelled) {
  const expression = text.match(/^    if: \$\{\{ (.+) \}\}$/mu)?.[1];
  assert.ok(expression);
  // GitHub string comparisons ignore case. Status functions are supplied by
  // GitHub, not by needs, event payload fields, runner placement or caller inputs.
  const evaluated = expression.replace(/([a-zA-Z][\w.]*) == ('[^']*'|true|false|[a-zA-Z][\w.]*)/gu, 'equal($1, $2)');
  return vm.runInNewContext(evaluated, {
    github, always: () => true, cancelled: () => isCancelled, equal: actionsEqual,
  }, { timeout: 1000 });
}
function aggregateResult(text, github, isCancelled, results) {
  if (!aggregateRuns(text, github, isCancelled)) return 'skipped';
  const env = text.match(/([A-Z_]+): \$\{\{ toJSON\(needs\) \}\}/u)?.[1];
  assert.ok(env);
  const programs = [...text.matchAll(/          node <<'NODE'\n([\s\S]*?)          NODE/gu)]
    .map(match => match[1].replace(/^          /gmu, ''))
    .filter(program => program.includes('process.env.' + env));
  assert.equal(programs.length, 1);
  try {
    vm.runInNewContext(programs[0], {
      require: name => { assert.equal(name, 'node:assert/strict'); return assert; },
      process: { env: { [env]: JSON.stringify(results) } }, console: { log() {} },
    }, { timeout: 1000 });
    return 'success';
  } catch {
    return 'failure';
  }
}

test('only four job if lines differ from both complete reviewed workflows at 3a6554', () => {
  for (const workflow of cancellationWorkflows) {
    assert.equal(workflow.text.split(aggregateIf).length - 1, workflow.keys.length, workflow.file);
    for (const key of workflow.keys) {
      const text = workflow.text.split('\n  ' + key + ':\n')[1].split(/\n  [\w-]+:\n/u)[0];
      assert.ok(text.includes(aggregateIf + '\n'), key);
    }
    // The old guard is reconstructed literally; all routes, needs, inline gates,
    // permissions, concurrency, timeouts and step-level always cleanup stay exact.
    const original = workflow.text.replaceAll(aggregateIf, '    if: ${{ always() }}');
    assert.equal(createHash('sha256').update(original).digest('hex'), workflow.previousHash, workflow.file);
  }
});

test('only a cancelled canonical protected-main push can skip any of the four aggregates', () => {
  for (const aggregate of cancellationAggregates)
    for (const repository of ['instafy-dev/instafy', 'someone/instafy'])
      for (const event_name of ['push', 'pull_request', 'workflow_dispatch', 'workflow_call', 'merge_group', 'pull_request_target', 'schedule'])
        for (const ref of ['refs/heads/main', 'refs/heads/topic', 'refs/pull/2/merge'])
          for (const ref_protected of [true, false, null, undefined])
            for (const isCancelled of [true, false]) {
              const github = { repository, event_name, ref, ref_protected };
              const shouldSkip = repository === 'instafy-dev/instafy' && event_name === 'push'
                && ref === 'refs/heads/main' && ref_protected === true && isCancelled;
              assert.equal(aggregateRuns(aggregate.text, github, isCancelled), !shouldSkip,
                aggregate.key + '/' + JSON.stringify({ github, isCancelled }));
            }
});

test('the predicate fixture models numeric coercion without mistaking it for typed GitHub context', () => {
  // ref_protected is a GitHub-owned BOOLEAN in real runs, not a caller input.
  // Unlike a strict JS mock, Actions would also consider synthetic 1/"1" true.
  const values = [
    [true, false], [false, true], [null, true], [undefined, true],
    [1, false], ['1', false], ['1.0', false], ['1e0', false],
    [0, true], ['0', true], ['', true], [' ', true],
    ['true', true], ['false', true], ['unknown', true],
    [[], true], [[1], true], [{}, true], [{ value: 1 }, true],
  ];
  for (const aggregate of cancellationAggregates) for (const [ref_protected, shouldRun] of values) {
    const github = { ...context('push'), ref_protected };
    assert.equal(aggregateRuns(aggregate.text, github, true), shouldRun, JSON.stringify(ref_protected));
    assert.equal(aggregateRuns(aggregate.text, github, false), true);
  }
});

test('missing context fields stay always-run and event payloads cannot supply workflow cancellation', () => {
  for (const aggregate of cancellationAggregates) {
    for (const field of ['repository', 'event_name', 'ref', 'ref_protected']) {
      const github = context('push'); delete github[field];
      for (const isCancelled of [false, true]) assert.equal(aggregateRuns(aggregate.text, github, isCancelled), true, field);
    }
    const github = { ...context('push'), event: { cancelled: true, workflow_run: { conclusion: 'cancelled' } } };
    assert.equal(aggregateRuns(aggregate.text, github, false), true);
    // Documented GitHub string equality is case-insensitive, not JS strict equality.
    assert.equal(aggregateRuns(aggregate.text, { ...github, repository: 'INSTAFY-DEV/INSTAFY', event_name: 'PUSH', ref: 'REFS/HEADS/MAIN' }, true), false);
  }
});

test('PR and manual cancellation retain exact fail-closed gates; uncancelled main rejects cancelled children too', () => {
  for (const aggregate of cancellationAggregates) {
    const children = aggregate.text.match(/    needs:\n((?:      - .+\n)+)/u)[1]
      .trim().split('\n').map(line => line.trim().slice(2));
    const success = Object.fromEntries(children.map(key => [key, { result: 'success' }]));
    const fixtures = [success];
    for (const child of children) {
      for (const result of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', '', 'Success', null])
        fixtures.push({ ...success, [child]: { result } });
      const missing = { ...success }; delete missing[child]; fixtures.push(missing);
    }
    fixtures.push(null, [], {}, { ...success, unexpected: { result: 'success' } });
    for (const event of ['pull_request', 'workflow_dispatch', 'push']) for (const isCancelled of [false, true]) {
      const github = context(event);
      for (const fixture of fixtures) {
        const expected = event === 'push' && isCancelled ? 'skipped' : fixture === success ? 'success' : 'failure';
        assert.equal(aggregateResult(aggregate.text, github, isCancelled, fixture), expected,
          aggregate.key + '/' + event + '/' + isCancelled + '/' + JSON.stringify(fixture));
      }
    }
  }
});

test('the required JavaScript identity is a strict aggregate, not a replacement context', () => {
  const aggregate = job('javascript');
  assert.match(aggregate, /^    name: JavaScript packages$/mu);
  const needs = aggregate.match(/    needs:\n((?:      - .+\n)+)/u)?.[1].trim().split('\n').map(line => line.trim().slice(2));
  assert.deepEqual(needs, lanes.map(lane => lane.key));
  assert.ok(aggregate.includes(aggregateIf + '\n'));
  assert.match(aggregate, /^    timeout-minutes: 5$/mu);
  assert.match(aggregate, /^    permissions: \{\}$/mu);
  assert.match(aggregate, /JAVASCRIPT_RESULTS: \$\{\{ toJSON\(needs\) \}\}/u);
  assert.doesNotMatch(aggregate, /uses:|checkout|continue-on-error|secrets\.|environment:|fetch\(/u);
});

test('the actual inline aggregate rejects failure, cancellation, skipped or missing children', () => {
  const program = javascript('javascript', 'Require every JavaScript lane to succeed');
  const success = Object.fromEntries(lanes.map(lane => [lane.key, { result: 'success', outputs: {} }]));
  const check = value => vm.runInNewContext(program, {
    require: name => { assert.equal(name, 'node:assert/strict'); return assert; },
    process: { env: { JAVASCRIPT_RESULTS: JSON.stringify(value) } }, console: { log() {} },
  }, { timeout: 1000 });
  assert.doesNotThrow(() => check(success));
  for (const lane of lanes) {
    for (const result of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', '', 'Success', null]) {
      assert.throws(() => check({ ...success, [lane.key]: { result } }), `${lane.key}/${result}`);
    }
    const missing = { ...success }; delete missing[lane.key]; assert.throws(() => check(missing));
  }
  for (const malformed of [{}, [], null, { ...success, unexpected: { result: 'success' } }]) assert.throws(() => check(malformed));
});

test('five selectors are independently default-off and use only exclusive per-job identities', () => {
  assert.equal((source.match(/vars\.CI_JAVASCRIPT_SELF_HOSTED/g) ?? []).length, 5);
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
  assert.equal(labels.size, 5);
});

test('public visibility, forks, different repositories and unsupported events retain hosted runners', () => {
  for (const item of jobs) {
    for (const event of ['workflow_dispatch', 'pull_request_target', 'merge_group', 'schedule', 'workflow_run', 'release']) {
      assert.equal(route(item.key, context(event), 'true'), 'ubuntu-latest');
    }
    for (const event of ['push', 'pull_request']) for (const mutate of [
      g => { g.repository = 'someone/instafy'; }, g => { g.event.repository.private = false; },
      ...(event === 'pull_request' ? [g => { g.event.pull_request.base.ref = 'topic'; },
        g => { g.event.pull_request.head.repo.fork = true; }, g => { g.event.pull_request.head.repo.full_name = 'someone/instafy'; },
        g => { g.event.pull_request.base.repo.full_name = 'someone/instafy'; }] : [g => { g.ref = 'refs/heads/topic'; }, g => { g.ref_protected = false; }]),
    ]) {
      const github = context(event); mutate(github); assert.equal(route(item.key, github, 'true'), 'ubuntu-latest');
    }
  }
});

test('every bounded child independently checks out and installs the same exact Node20 monorepo', () => {
  for (const lane of lanes) {
    const text = job(lane.key);
    assert.match(text, new RegExp(`^    name: ${lane.name}$`, 'mu'));
    assert.match(text, /^    timeout-minutes: 30$/mu);
    assert.doesNotMatch(text, /^    (?:if|needs|strategy|environment):|continue-on-error|secrets\./mu);
    assert.match(text, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u);
    assert.match(text, /submodules: recursive/u);
    assert.match(text, /persist-credentials: false/u);
    assert.match(text, /ref: \$\{\{ github\.sha \}\}/u);
    assert.match(text, /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1/u);
    assert.match(text, /node-version: "20"/u);
    assert.equal((text.match(/run: pnpm install --frozen-lockfile$/gmu) ?? []).length, 1);
    assert.doesNotMatch(step(lane.key, 'Install dependencies'), /--ignore-scripts|--filter/u);
    assert.match(text, /run: node --test scripts\/check-javascript-ci\.test\.mjs/u);
    assert.ok(text.indexOf('Qualify isolated JavaScript CI runner') < text.indexOf('Checkout repository'));
  }
});

test('all original migration and contract checks remain together including the real empty-database test', () => {
  const text = job('javascript-contracts');
  for (const filename of ['check-public-boundary-workflow', 'check-production-image-inputs', 'check-production-services-workflow',
    'check-public-release-workflows', 'check-changesets', 'verify-changeset-pack', 'lib/codexMachineAuthExpiry',
    'check-supabase-migrations', 'test-supabase-migrations-empty-db', 'ensure-supabase-postgres-image', 'check-self-host-compose']) {
    assert.equal(text.split(`scripts/${filename}.test.mjs`).length - 1, 1, filename);
    assert.ok(fs.existsSync(path.join(root, `scripts/${filename}.test.mjs`)));
  }
  for (const file of ['check-supabase-migrations', 'check-self-host-compose', 'ensure-supabase-postgres-image', 'test-supabase-migrations-empty-db']) {
    assert.equal(text.split(`node scripts/${file}.mjs`).length - 1, 1, file);
  }
  assert.match(text, /supabase-postgres-image-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-/u);
  assert.ok(text.indexOf('Ensure Supabase Postgres image') < text.indexOf('Apply public migrations to an empty database'));
});

test('the complete pre-split command inventory and working directories are unchanged', () => {
  // Reviewed inventory from build.yml at db5e0c1. Hash normalized run text plus
  // working-directory, not just command substrings that could hide new skips.
  const original = {
    'Install dependencies': 'e77ccc60f79964794528b62d01c6c28548ed751c0da9fb1ed7f94c1ed7e8ce17',
    'Validate public migration ordering': '7d8920702565c08045672b91f0a08a35295ef2bf65e7ea9f464fe3bc173a195e',
    'Test public migration and self-host contracts': '2fc2836399636c2f6038bdfff42c91fa1b133335e9132e2ba6701469733e34cb',
    'Ensure Supabase Postgres image': 'fcb66564f9c4cb18b6612898669e1f23c0c21328f9f69a0771e7b3980dfaf930',
    'Apply public migrations to an empty database': '945388b69cfddc6f588f366844e61ffecaee1106b92b3bb4e88d9f89902a395a',
    'Lint frontend': 'a23bfd0831c63f63e596b3d19225888a844d89f50bf043891c3c005b5b42480b',
    'Build frontend': 'a0c1e2b06183a6a4e579239c8e2dd3c478af5e3cf997731352d78b922010c4ef',
    'Test frontend': 'e9eda1215dd3971adc519c004a8098f14100da342c17fe7a4685200c0eb15047',
    'Test CLI package artifact': 'dc53d4deb7f3e7c8871633518a5ed275082e12e4735fa878399600f589d01356',
    'Validate provider contract package artifact': '70cfd1c44e4399e020c5a23459544c7e30820717e8b921ff814b963c4d8cb3c2',
    'Test CLI automations': '3da818db0a82364c31588e4bf6ba8a38a7cd30e5bd3d755eea0058644a5c9001',
    'Build and test desktop runtime': '4404b931ad4c93454f1acb37955f5059b7f3df6ac9cf9ffa81e92d3306481e73',
    'Build and test desktop app': '189e65ceed9465ec56589e5b804be189a9adc623daf4f4f3cee05b4b846a5ba5',
  };
  const found = [];
  for (const lane of lanes) for (const part of job(lane.key).split('      - name: ').slice(1)) {
    const name = part.split('\n')[0];
    if (['Qualify isolated JavaScript CI runner', 'Verify JavaScript CI coverage and routing'].includes(name)) continue;
    const match = part.match(/^        run: (.*)(?:\n|$)/mu);
    if (!match) continue;
    assert.doesNotMatch(part, /^        (?:if|continue-on-error|timeout-minutes|env):/mu, name);
    const run = match[1] === '|'
      ? part.slice(match.index + match[0].length).split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n').trim()
      : match[1];
    const workingDirectory = part.match(/^        working-directory: (.*)$/mu)?.[1] ?? null;
    assert.equal(createHash('sha256').update(JSON.stringify({ run, workingDirectory })).digest('hex'), original[name], name);
    found.push(name);
  }
  assert.deepEqual(found.sort(), [...Object.keys(original), ...Array(3).fill('Install dependencies')].sort());
});

test('the full frontend, CLI, provider artifact and Desktop commands are preserved without filtering', () => {
  const commands = {
    'javascript-frontend': ['pnpm --filter @instafy/frontend lint', 'pnpm --filter @instafy/frontend build', 'pnpm --filter @instafy/frontend test:unit'],
    'javascript-cli': ['pnpm --filter @instafy/cli test:package', 'npm pack --dry-run --ignore-scripts', 'pnpm --filter @instafy/cli exec vitest run test/automations.e2e.spec.ts'],
    'javascript-desktop': ['pnpm --filter @instafy/desktop-runtime-agent build', 'pnpm --filter @instafy/desktop-runtime-agent exec vitest run', 'pnpm --filter @instafy/desktop-app test'],
  };
  for (const [key, list] of Object.entries(commands)) for (const command of list) {
    assert.equal(job(key).split(command).length - 1, 1, command);
    assert.equal(lanes.reduce((count, lane) => count + (job(lane.key).split(command).length - 1), 0), 1, command);
  }
  assert.match(step('javascript-cli', 'Validate provider contract package artifact'), /working-directory: packages\/provider-contract/u);
});

test('inline guest qualification rejects wrong identity and a non-ARM Linux Docker service', () => {
  for (const item of jobs) {
    const program = javascript(item.key, 'Qualify isolated JavaScript CI runner');
    const evaluate = (processOverride = {}, engine = { OSType: 'linux', Architecture: 'aarch64' }) => {
      const calls = [];
      vm.runInNewContext(program, { process: { platform: 'linux', arch: 'arm64', getuid: () => 503, versions: { node: '22.23.2' },
        env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'ARM64', INSTAFY_CI_JOB_ISOLATION: 'ephemeral' }, ...processOverride },
        require: name => name === 'node:assert/strict' ? assert : { execFileSync(file, args) {
          calls.push([file, args]); return file === 'docker' ? JSON.stringify(engine) : '';
        } },
      }, { timeout: 1000 });
      return calls;
    };
    assert.doesNotThrow(() => evaluate());
    for (const override of [{ platform: 'darwin' }, { arch: 'x64' }, { getuid: () => 0 }, { versions: { node: '20.20.2' } }, { env: {} },
      { env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'ARM64', INSTAFY_CI_JOB_ISOLATION: 'ephemeral', INSTAFY_ENV_DIR: '/inert' } }]) assert.throws(() => evaluate(override));
    if (item.key === 'javascript-contracts') {
      assert.ok(evaluate().some(([file]) => file === 'docker'));
      assert.throws(() => evaluate({}, { OSType: 'linux', Architecture: 'x86_64' }));
      assert.throws(() => evaluate({}, { OSType: 'windows', Architecture: 'arm64' }));
    }
  }
});
