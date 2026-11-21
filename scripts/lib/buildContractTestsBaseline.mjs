import assert from "node:assert/strict";

// Test-only inverse of the node --test files added to the Build workflow's
// "Test public migration and self-host contracts" step after its whole-file
// baselines were reviewed; not runtime authority. Every entry must be present
// exactly once, so dropping one from CI fails here instead of passing quietly.
export const ADDED_BUILD_CONTRACT_TESTS = [
  "scripts/lib/localUserTokenSecret.test.mjs",
  "scripts/lib/supabaseImageMirror.test.mjs",
  "scripts/mirror-supabase-images.test.mjs",
  "scripts/lib/dockerHubImageMirror.test.mjs",
  "scripts/mirror-docker-hub-images.test.mjs",
  "scripts/check-docker-hub-mirror-workflows.test.mjs",
  "scripts/lib/supabaseStartMode.test.mjs",
  "scripts/lib/supabaseSerialPull.test.mjs",
  "scripts/check-origin-git-compat-ci.test.mjs",
  "scripts/lib/localSecret.test.mjs",
  "scripts/lib/localTunnelBroker.test.mjs",
  "scripts/lib/devStackProcesses.test.mjs",
  "scripts/dev-stack-ports.test.mjs",
  "scripts/lib/prebuiltRustBinary.test.mjs",
  "scripts/supabase-migrations-mirror.test.mjs",
  "scripts/octo-turn-grade.test.mjs",
  "scripts/generate-octo-hatchlings.test.mjs",
  "scripts/fake-rate-limit-upstream.test.mjs",
  "scripts/octo-turn-release.test.mjs",
  "scripts/install-skill-packs.test.mjs",
  "scripts/lib/app-icon-checker.test.mjs",
  "scripts/lib/controllerTestMigrations.test.mjs",
  "scripts/lib/gitServicesImageFingerprint.test.mjs",
  "scripts/lib/localSupabaseEnv.test.mjs",
  "scripts/lib/og-image.test.mjs",
  "scripts/lib/otaReleaseHelpers.test.mjs",
  "scripts/lib/prebuiltRustBinary.test.mjs",
  "scripts/lib/privateEnvPaths.test.mjs",
  "scripts/lib/proxyCredentialMode.test.mjs",
  "scripts/lib/runtimeEnvHelpers.test.mjs",
  "scripts/lib/stackBrowserHost.test.mjs",
  "scripts/lib/supabaseEmailTemplateMounts.test.mjs",
  "scripts/mint-test-user.test.mjs",
  "scripts/release/android/browser-safe-supabase-key.test.mjs",
  "scripts/release/android/gitleaks-release-artifact.test.mjs",
  "scripts/release/android/google-play-internal.test.mjs",
  "scripts/release/android/inspect-aab.test.mjs",
  "scripts/release/android/mobile-versions.test.mjs",
  "scripts/release/android/release-refs.test.mjs",
  "scripts/release/android/trust-key.test.mjs",
  "scripts/release/android/verify-release-tag.test.mjs",
  "scripts/release/android/workflow-guard.test.mjs",
  "scripts/release/android/write-receipt.test.mjs",
  "scripts/release/downloads-worker/verify-live-feed.test.mjs",
  "scripts/release/downloads-worker/verify-wrangler-contract.test.mjs",
  "scripts/release/ios/asc.test.mjs",
  "scripts/release/ios/bind-signing.test.mjs",
  "scripts/release/ios/browser-safe-supabase-key.test.mjs",
  "scripts/release/ios/gitleaks-release-artifact.test.mjs",
  "scripts/release/ios/identity-certificate.test.mjs",
  "scripts/release/ios/inspect-native-ota.test.mjs",
  "scripts/release/ios/install-profile.test.mjs",
  "scripts/release/ios/mobile-versions.test.mjs",
  "scripts/release/ios/select-xcode.test.mjs",
  "scripts/release/ios/verify-release-tag.test.mjs",
  "scripts/release/ios/verify-trust-anchor.test.mjs",
  "scripts/release/ios/workflow-guard.test.mjs",
  "scripts/release/ios/write-receipt.test.mjs",
  "scripts/release/ota/browser-safe-config.test.mjs",
  "scripts/release/ota/gitleaks-release-artifact.test.mjs",
  "scripts/release/ota/read-committed-mobile-versions.test.mjs",
  "scripts/release/ota/shell-helpers.test.mjs",
  "scripts/release/ota/tag-state.test.mjs",
  "scripts/release/ota/validate-ota-web-archive.test.mjs",
  "scripts/release/ota/verify-public-bytes.test.mjs",
  "scripts/release/ota/verify-release-tag.test.mjs",
  "scripts/release/ota/workflow-guard.test.mjs",
  "scripts/release/ota/write-receipt.test.mjs",
  "scripts/render-ota-release-payload.test.mjs",
  "scripts/run-e2e-dev-model.test.mjs",
  "scripts/turn-relay-smoke.test.mjs",
  "scripts/check-script-tests-ci.test.mjs",
];

export const addedBuildContractTestLine = (file) => `            ${file} \\\n`;

export function withoutAddedBuildContractTests(source) {
  for (const file of ADDED_BUILD_CONTRACT_TESTS) {
    const line = addedBuildContractTestLine(file);
    assert.equal(source.split(line).length, 2, `${file} must run exactly once in build.yml`);
    source = source.replace(line, "");
  }
  return source;
}
