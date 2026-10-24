import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export default createStyleReviewConfig({ name: "conversation-view-tabs", port: 5247, stubs: RUN_STOP_FIXTURE_STUBS });
