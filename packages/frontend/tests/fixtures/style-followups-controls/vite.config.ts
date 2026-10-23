import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";

export default createStyleReviewConfig({
  name: "controls",
  port: 5242,
  stubs: {
    "virtual:instafy/frontend-feature-manifest": "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];",
    "/src/assistants/localBuiltInAssistantCatalog.ts": 'export const getDefaultAssistantHandle = () => "octo"; export const resolveBuiltInAssistantHandle = handle => handle;',
    "/src/services/runtimeController/browserShares.ts": 'export { browserShareClient } from "/tests/fixtures/style-followups-controls/browserData.ts";',
    "/src/services/runtimeController/localTabVideoViewer.ts": 'export const localTabVideoViewer = () => ({ playing: false, receive() {}, setView() {}, setViewport() {}, dispose() {} });',
  },
});
