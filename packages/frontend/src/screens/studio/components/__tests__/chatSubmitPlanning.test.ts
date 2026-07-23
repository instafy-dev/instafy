import { describe, expect, it } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import { buildChatSubmitPlan } from "../chatSubmitPlanning";

const assistantSelection: ResolvedPromptAgentSelection = {
  activeHandles: ["codex"],
  explicitMentionedHandles: [],
  mentionedHandles: [],
  targetHandles: ["codex"],
  nextStickyMentionedAgent: null,
  usesDefaultAssistantOnly: true,
};

const sharedPage = {
  id: "shared-page-1",
  url: "https://example.com/",
  host: "example.com",
  label: "Example",
  title: "Example",
  lastReferencedAt: 1,
  isActive: true,
};

function buildPlan(browserTargetingEnabled: boolean, overrideBrowserTargeting = false) {
  return buildChatSubmitPlan({
    activeConversationMessages: [],
    browserTargetingEnabled,
    browserSessionOpen: true,
    hasHiddenBrowserSession: false,
    imageAttachmentCount: 0,
    inputValue: "Open the current page and summarize it",
    override: overrideBrowserTargeting
      ? {
          message: "Open the current page and summarize it",
          editorState: null,
          browserPageTarget: sharedPage,
          browserLaunchMode: "new_page",
        }
      : undefined,
    pendingBrowserLaunchMode: "new_page",
    preferredBrowserPage: sharedPage,
    resolvePromptAgentTargets: () => assistantSelection,
    softPrefillSuggestion: null,
  });
}

describe("buildChatSubmitPlan browser transport targeting", () => {
  it("keeps Shared browser launch targeting enabled", () => {
    const plan = buildPlan(true);

    expect(plan.browserLaunchMode).toBe("new_page");
    expect(plan.shouldApplyNewBrowserLaunch).toBe(true);
    expect(plan.dispatchedMessage).toContain("fresh browser page/context");
  });

  it("strips pending and explicit Shared targets for Personal Browser dispatch", () => {
    for (const overrideBrowserTargeting of [false, true]) {
      const plan = buildPlan(false, overrideBrowserTargeting);

      expect(plan.browserLaunchMode).toBeNull();
      expect(plan.browserPageTarget).toBeNull();
      expect(plan.shouldApplyBrowserPageTarget).toBe(false);
      expect(plan.shouldApplyNewBrowserLaunch).toBe(false);
      expect(plan.dispatchedMessage).toBe("Open the current page and summarize it");
    }
  });
});
