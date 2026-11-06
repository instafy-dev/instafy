import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export default createStyleReviewConfig({ name: "message-actions", port: 5412, stubs: {
  "/src/features/applicationFrontendFeatureComposition.ts": RUN_STOP_FIXTURE_STUBS["/src/features/applicationFrontendFeatureComposition.ts"],
  "/src/lib/supabaseClient.ts": RUN_STOP_FIXTURE_STUBS["/src/lib/supabaseClient.ts"],
} });
