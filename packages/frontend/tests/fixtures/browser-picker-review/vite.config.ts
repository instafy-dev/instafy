import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";
export default createStyleReviewConfig({ name: "browser-picker-review", port: 5424, stubs: {
  "/src/features/applicationFrontendFeatureComposition.ts": RUN_STOP_FIXTURE_STUBS["/src/features/applicationFrontendFeatureComposition.ts"],
  "/src/assistants/localBuiltInAssistantCatalog.ts": RUN_STOP_FIXTURE_STUBS["/src/assistants/localBuiltInAssistantCatalog.ts"],
  "/src/lib/supabaseClient.ts": RUN_STOP_FIXTURE_STUBS["/src/lib/supabaseClient.ts"],
  "/src/services/runtimeController/browserShares.ts": `export const browserShareClient = async () => window.__browserPickerReview;`,
  "/src/services/runtimeController/localTabVideoViewer.ts": `export const localTabVideoViewer = () => ({ playing: false, receive() {}, setViewport() {}, setView() {}, dispose() {}, decoded: () => false });`,
} });
