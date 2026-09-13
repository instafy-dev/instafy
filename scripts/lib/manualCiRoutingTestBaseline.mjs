// Test-only finite inverse for the protected-main manual CI additions.
// Each complete original workflow is hash-checked by check-manual-ci-routing.test.mjs.
export const MANUAL_CI_JOBS = [
  {"file":"build.yml","key":"secret-scan","toggle":"CI_EXPANDED_SELF_HOSTED","label":"public-secret-scan","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"javascript","toggle":"CI_JAVASCRIPT_SELF_HOSTED","label":"public-js-aggregate","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"javascript-contracts","toggle":"CI_JAVASCRIPT_SELF_HOSTED","label":"public-js-contracts","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"javascript-frontend","toggle":"CI_JAVASCRIPT_SELF_HOSTED","label":"public-js-frontend","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"javascript-cli","toggle":"CI_JAVASCRIPT_SELF_HOSTED","label":"public-js-cli","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"javascript-desktop","toggle":"CI_JAVASCRIPT_SELF_HOSTED","label":"public-js-desktop","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"go","toggle":"CI_EXPANDED_SELF_HOSTED","label":"public-go","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-check-aggregate","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-check-controller","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-check-controller","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-check-agent","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-check-agent","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-check-git","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-check-git","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-check-provider","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-check-provider","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-check-tunnel","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-check-tunnel","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-fmt","toggle":"CI_EXPANDED_SELF_HOSTED","label":"public-rust-fmt","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-tests","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-test-aggregate","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-test-contracts","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-test-contracts","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-test-agent","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-test-agent","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-test-proxy","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-test-proxy","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-test-origin","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-test-origin","hosted":"ubuntu-latest"},
  {"file":"build.yml","key":"rust-test-git","toggle":"CI_RUST_SELF_HOSTED","label":"public-rust-test-git","hosted":"ubuntu-latest"},
  {"file":"browser-e2e.yml","key":"personal","toggle":"CI_BROWSER_SELF_HOSTED","label":"public-browser-personal","hosted":"ubuntu-24.04"},
  {"file":"browser-e2e.yml","key":"browser-ui","toggle":"CI_BROWSER_SELF_HOSTED","label":"public-browser-ui","hosted":"ubuntu-24.04"},
  {"file":"browser-e2e.yml","key":"shared-profile","toggle":"CI_SHARED_BROWSER_SELF_HOSTED","label":"public-shared-browser-aggregate","hosted":"ubuntu-24.04"},
  {"file":"browser-e2e.yml","key":"shared-profile-lifecycle","toggle":"CI_SHARED_BROWSER_SELF_HOSTED","label":"public-shared-browser-profile","hosted":"ubuntu-24.04"},
  {"file":"browser-e2e.yml","key":"shared-studio","toggle":"CI_SHARED_BROWSER_SELF_HOSTED","label":"public-shared-browser-studio","hosted":"ubuntu-24.04"},
  {"file":"auth-email.yml","key":"auth-email","toggle":"CI_DATABASE_SELF_HOSTED","label":"public-auth-email","hosted":"ubuntu-latest"},
  {"file":"controller-db-tests.yml","key":"controller-db-tests","toggle":"CI_DATABASE_SELF_HOSTED","label":"public-controller-db","hosted":"ubuntu-latest"},
  {"file":"git-conflict-canary.yml","key":"deterministic-conflict","toggle":"CI_GIT_CONFLICT_SELF_HOSTED","label":"deterministic-conflict","hosted":"ubuntu-latest"},
  {"file":"npm-release.yml","key":"select","toggle":"CI_PUBLIC_CONTROL_SELF_HOSTED","label":"public-npm-select","hosted":"ubuntu-24.04"},
  {"file":"npm-release.yml","key":"version","toggle":"CI_PUBLIC_CONTROL_SELF_HOSTED","label":"public-npm-version","hosted":"ubuntu-24.04"},
  {"file":"npm-release.yml","key":"pack","toggle":"CI_PUBLIC_CONTROL_SELF_HOSTED","label":"public-npm-pack","hosted":"ubuntu-24.04"},
];
export const MANUAL_CI_BASELINES = {
  "build.yml": "50dc11f4e96d43a883119d868e4f5ae846f82065c33bc5ee5f0addb94b80d0d6",
  "browser-e2e.yml": "5a227820568dfe71f344bd816f77fe41c4d1d8980041937792de09ab956c121b",
  "auth-email.yml": "198c97e67fe98118e3ee90c1f70dff088e2c00935f13dbf7e41eefad4d431e8a",
  "controller-db-tests.yml": "465d5f037751932001abdc9956dba92327ab8483de91af47a627eae3d3b5d5e3",
  "git-conflict-canary.yml": "8c7e5c51772e998058fba924e3eff5fb166d5b012856f56b2bcf6d208a47de3b",
  "npm-release.yml": "07f5c41b6ed624ce3d511dd43eda470573aefafd334996cfd76c8a072407612b"
};

export function manualCiBranch(job) {
  const ref = file => `github.workflow_ref == 'instafy-dev/instafy/.github/workflows/${file}@refs/heads/main'`;
  const workflow = job.file === 'browser-e2e.yml'
    ? `(${ref('build.yml')} || ${ref(job.file)})` : ref(job.file);
  return `          || (vars.${job.toggle} == 'true'
              && github.repository == 'instafy-dev/instafy'
              && github.repository_id == '1309636737'
              && github.event.repository.private == true
              && github.event_name == 'workflow_dispatch'
              && github.ref == 'refs/heads/main'
              && github.ref_protected == true
              && ${workflow}
              && github.workflow_sha == github.sha
              && fromJSON(format('{{"group":"org/instafy-ci-main","labels":["self-hosted","Linux","ARM64","instafy-ci-bootstrap-{0}-{1}-{2}-${job.label}","instafy-ci-trust-main"]}}', github.repository_id, github.run_id, github.run_attempt)))
`;
}
export const manualControlGuard = `          assert.ok(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
          if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') assert.equal(process.env.GITHUB_WORKFLOW_SHA, process.env.GITHUB_SHA);
`;
export const previousControlGuard = "          assert.equal(process.env.GITHUB_EVENT_NAME, 'push');\n";

export function withoutManualCiRouting(file, source) {
  for (const job of MANUAL_CI_JOBS.filter(item => item.file === file)) source = source.replace(manualCiBranch(job), '');
  if (file === 'npm-release.yml') source = source.replaceAll(manualControlGuard, previousControlGuard);
  return source;
}
