import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { MANUAL_CI_JOBS, MANUAL_CI_BASELINES, manualCiBranch, withoutManualCiRouting } from './lib/manualCiRoutingTestBaseline.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
function section(source, key) {
  const blocks = source.split(`\n  ${key}:\n`);
  assert.equal(blocks.length, 2);
  return blocks[1].split(/\n  [\w-]+:\n/u)[0];
}
function context(job, event = 'workflow_dispatch') {
  const pr = event === 'pull_request';
  return { repository: 'instafy-dev/instafy', repository_id: '1309636737', run_id: '2002', run_attempt: '3',
    event_name: event, ref: pr ? 'refs/pull/11/merge' : 'refs/heads/main', ref_protected: !pr,
    sha: 'a'.repeat(40), workflow_sha: 'a'.repeat(40),
    workflow_ref: `instafy-dev/instafy/.github/workflows/${job.file}@${pr ? 'refs/pull/11/merge' : 'refs/heads/main'}`,
    event: { repository: { private: true }, ...(pr ? { pull_request: { number: 11,
      base: { ref: 'main', repo: { full_name: 'instafy-dev/instafy' } },
      head: { repo: { full_name: 'instafy-dev/instafy', fork: false } } } } : {}) } };
}
function select(job, github, source = read(job.file), toggle) {
  if (arguments.length < 4) toggle = 'true';
  const expression = section(source, job.key).match(/^    runs-on: >-\n((?:      .*\n)+)/mu)[1]
    .trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, '')
    .replace(/([a-zA-Z][\w.]*) == ('[^']*'|true|false|(?:github|vars)\.[\w.]+)/gu, 'equal($1, $2)');
  const result = vm.runInNewContext(expression, { github,
    vars: Object.fromEntries(MANUAL_CI_JOBS.map(item => [item.toggle, item.toggle === job.toggle ? toggle : 'true'])),
    equal: (a,b) => typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b,
    fromJSON: JSON.parse,
    format: (template,...values) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match,index) => match === '{{' ? '{' : match === '}}' ? '}' : String(values[index])),
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(result));
}
for (const [file, hash] of Object.entries(MANUAL_CI_BASELINES)) test(`manual routing reconstructs the complete original ${file}`, () => {
  const source = read(file);
  for (const job of MANUAL_CI_JOBS.filter(item => item.file === file)) assert.equal(source.split(manualCiBranch(job)).length, 2);
  assert.equal(createHash('sha256').update(withoutManualCiRouting(file, source)).digest('hex'), hash);
});
for (const job of MANUAL_CI_JOBS) test(`exact-main manual selector ${job.file}/${job.key}`, () => {
  const valid = context(job), selected = select(job, valid);
  assert.deepEqual(selected, { group: 'org/instafy-ci-main', labels: ['self-hosted','Linux','ARM64',
    `instafy-ci-bootstrap-1309636737-2002-3-${job.label}`, 'instafy-ci-trust-main'] });
  for (const toggle of ['', undefined, 'false', 'self-hosted']) assert.equal(select(job, valid, read(job.file), toggle), job.hosted);
  for (const mutate of [
    g => { g.repository = 'someone/instafy'; }, g => { g.repository_id = '1309636738'; },
    g => { g.event.repository.private = false; }, g => { delete g.event.repository.private; },
    g => { g.ref = 'refs/heads/topic'; }, g => { g.ref = 'refs/tags/v1'; },
    g => { g.ref_protected = false; }, g => { delete g.ref_protected; },
    g => { g.workflow_ref = g.workflow_ref.replace('@refs/heads/main', '@refs/heads/topic'); },
    g => { g.workflow_ref = 'instafy-dev/instafy/.github/workflows/unrelated.yml@refs/heads/main'; },
    g => { g.workflow_sha = 'b'.repeat(40); }, g => { delete g.workflow_sha; },
  ]) { const changed = structuredClone(valid); mutate(changed); assert.equal(select(job, changed), job.hosted); }
});
test('every automatic and unsupported event preserves the original selector result', () => {
  for (const job of MANUAL_CI_JOBS) for (const event of ['push','pull_request','pull_request_target','merge_group','repository_dispatch','schedule','workflow_run','release','workflow_call']) {
    const source = read(job.file), baseline = withoutManualCiRouting(job.file, source);
    for (const change of [() => {}, g => { g.event.repository.private = false; }, g => { g.ref_protected = false; }]) {
      const github = context(job,event);
      if (job.file === 'browser-e2e.yml') github.workflow_ref = github.workflow_ref.replace('browser-e2e.yml','build.yml');
      change(github);
      assert.deepEqual(select(job,github,source),select(job,github,baseline), `${job.key}/${event}`);
    }
  }
});
test('manual Browser permits only its standalone identity or the existing exact Build caller', () => {
  for (const job of MANUAL_CI_JOBS.filter(item => item.file === 'browser-e2e.yml')) {
    const github = context(job);
    github.workflow_ref = github.workflow_ref.replace('browser-e2e.yml','build.yml');
    assert.equal(select(job,github).group,'org/instafy-ci-main');
    github.workflow_ref = github.workflow_ref.replace('build.yml','npm-release.yml');
    assert.equal(select(job,github),job.hosted);
  }
});
for (const job of MANUAL_CI_JOBS.filter(item => item.file === 'npm-release.yml')) test(`actual npm ${job.key} preflight accepts only existing push or source-bound manual`, () => {
  const body = section(read(job.file),job.key).match(/          node <<'NODE'\n([\s\S]*?)          NODE/u)[1].replace(/^          /gmu,'');
  function execute(event, mutate = () => {}) {
    const process = { platform:'linux',arch:'arm64',getuid:()=>1000,versions:{node:'22.23.2'},
      env:{GITHUB_REPOSITORY:'instafy-dev/instafy',GITHUB_REPOSITORY_ID:'1309636737',GITHUB_EVENT_NAME:event,
      GITHUB_REF:'refs/heads/main',GITHUB_REF_PROTECTED:'true',GITHUB_WORKFLOW_REF:'instafy-dev/instafy/.github/workflows/npm-release.yml@refs/heads/main',
      GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW_SHA:'a'.repeat(40),RUNNER_OS:'Linux',RUNNER_ARCH:'ARM64',INSTAFY_CI_JOB_ISOLATION:'ephemeral'} };
    mutate(process.env);
    vm.runInNewContext(body,{process, require(name) { if(name === 'node:assert/strict') return assert;
      assert.equal(name,'node:child_process'); return {execFileSync(file,args,options) {
        assert.equal(file,'/bin/bash'); assert.equal(options.timeout,1000); return '';
      }}; }});
  }
  execute('workflow_dispatch'); execute('push',e=>{delete e.GITHUB_WORKFLOW_SHA;});
  for(const event of ['pull_request','repository_dispatch','schedule','workflow_call','']) assert.throws(()=>execute(event));
  for(const mutate of [e=>{e.GITHUB_WORKFLOW_SHA='b'.repeat(40);},e=>{delete e.GITHUB_WORKFLOW_SHA;},
    e=>{e.GITHUB_REF='refs/heads/topic';},e=>{e.GITHUB_REF_PROTECTED='false';},e=>{e.GITHUB_REPOSITORY_ID='1';}])
    assert.throws(()=>execute('workflow_dispatch',mutate));
});
test('manual scope stays exactly 31 definitions; npm policy/publish and image routes are untouched', () => {
  assert.equal(MANUAL_CI_JOBS.length,31);
  const source=read('npm-release.yml');
  for(const key of ['pull-request-policy','publish']) assert.equal(section(source,key),
    section(withoutManualCiRouting('npm-release.yml',source),key));
  assert.match(section(source,'publish'),/runs-on: ubuntu-24.04/u);
  assert.match(fs.readFileSync(path.join(root,'scripts/check-expanded-ci-routing.test.mjs'),'utf8'),
    /import "\.\/check-manual-ci-routing\.test\.mjs";/u);
});
