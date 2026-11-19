import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export default createStyleReviewConfig({ name: "browser-composer-consistency",
  port: process.env.INSTAFY_REVIEW_BASELINE_SRC ? 5461 : 5460,
  stubs: {
    ...RUN_STOP_FIXTURE_STUBS,
    "/src/services/runtimeController/browserShares.ts": `export { browserShareClient, publishLocalBrowserTab } from "/tests/fixtures/browser-composer-consistency/browserData.ts";`,
    "/src/services/runtimeController/localTabVideoViewer.ts": `export const localTabVideoViewer = () => ({ playing: false, receive() {}, setViewport() {}, setView() {}, dispose() {}, decoded: () => false });`,
  },
});
