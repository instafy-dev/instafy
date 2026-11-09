import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export default createStyleReviewConfig({
  name: "composer-browser-feedback",
  port: process.env.INSTAFY_REVIEW_BASELINE_SRC ? 5451 : 5450,
  stubs: RUN_STOP_FIXTURE_STUBS,
});
