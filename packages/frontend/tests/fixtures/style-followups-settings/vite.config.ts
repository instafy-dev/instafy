import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";

const adapters = "/tests/fixtures/style-followups-settings/adapters.ts";

export default createStyleReviewConfig({
  name: "settings", port: 5236,
  stubs: {
    "virtual:instafy/frontend-feature-manifest": "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];",
    "/src/assistants/localBuiltInAssistantCatalog.ts": 'export const getDefaultAssistantHandle = () => "octo"; export const resolveBuiltInAssistantHandle = handle => handle;',
    "/src/sdk/instafy.ts": `export { controllerClient } from "${adapters}";`,
    "/src/notifications/notificationDeviceSettings.ts": `export { getNotificationDeviceContext, readNotificationDeviceState } from "${adapters}";`,
    "/src/notifications/assistantMessageNotifications.ts": `export { enableMessageNotifications, disableMessageNotifications } from "${adapters}";`,
    "/src/runtime/runtimeMenuShared.ts": `export { writeClipboardText } from "${adapters}";`,
    "/src/sharing/nearbyInviteShare.ts": `export { canUseNearbyInviteShare, isNearbyInviteShareDismissalError, shareNearbyInvite } from "${adapters}";`,
    "/src/status/useStatus.tsx": `export { useStatus } from "${adapters}";`,
    // These static-import branches are never rendered by this guests-only fixture.
    "/src/screens/studio/components/ProjectProviderBindingsCard.tsx": 'export const ProjectProviderBindingsCard = () => { throw new Error("Provider bindings are outside this guests-only fixture."); };',
    "/src/screens/studio/components/SpaceIdentityEditor.tsx": 'export const SpaceIdentityEditor = () => { throw new Error("Space identity is outside this guests-only fixture."); };',
  },
});
