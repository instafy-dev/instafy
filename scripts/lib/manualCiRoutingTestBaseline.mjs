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
  // The reviewed Build baseline additionally selects proxy_retry_budget and
  // filtered read-reference integration tests; check-rust-ci binds their exact argv.
  "build.yml": { sha256: "70548038c41bda43078074e7f84b7372d63798ae8cc76eb2bef8ee62e24d59f5" },
  "browser-e2e.yml": { sha256: "5a227820568dfe71f344bd816f77fe41c4d1d8980041937792de09ab956c121b" },
  // The reviewed Auth and Controller DB baselines additionally trigger on the
  // GHCR image-mirror helper (and its lock/test for Auth, the serial-pull helper
  // for Controller DB); check-database-ci-routing binds those path lists.
  // Auth also triggers on its email-template contract test in both event filters.
  "auth-email.yml": { sha256: "131392418f749d19a71fc0cf557da98ec43d38073a35551bf8d5d3070a2c1973" },
  "controller-db-tests.yml": { sha256: "dbda9359add1eb75752d6723e720c1506eb87abaf2110be218a7a8493f65bd59" },
  "git-conflict-canary.yml": { sha256: "8c7e5c51772e998058fba924e3eff5fb166d5b012856f56b2bcf6d208a47de3b" },
  "npm-release.yml": { sha256: "07f5c41b6ed624ce3d511dd43eda470573aefafd334996cfd76c8a072407612b" }
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
