import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";
export default createStyleReviewConfig({ name: "browser-address-review", port: 5427, stubs: {
  "/src/features/applicationFrontendFeatureComposition.ts": RUN_STOP_FIXTURE_STUBS["/src/features/applicationFrontendFeatureComposition.ts"],
  "/src/assistants/localBuiltInAssistantCatalog.ts": RUN_STOP_FIXTURE_STUBS["/src/assistants/localBuiltInAssistantCatalog.ts"],
  "/src/lib/supabaseClient.ts": RUN_STOP_FIXTURE_STUBS["/src/lib/supabaseClient.ts"],
} });
