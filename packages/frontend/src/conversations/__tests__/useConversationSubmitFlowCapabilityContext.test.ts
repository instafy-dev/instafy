import { describe, expect, it } from "vitest";
import {
  buildBuiltInAssistantPromptContextMetadata,
  getDefaultAssistantHandle,
} from "../../assistants/localBuiltInAssistantCatalog";
import { LOCAL_CAPABILITY_DEFINITIONS } from "../../capabilities/localCapabilityCatalog";
import { buildAssistantCapabilityContextForTargets } from "../useConversationSubmitFlow";

describe("buildAssistantCapabilityContextForTargets", () => {
  it("keeps the public core assistant context byte-equivalent", () => {
    const coreHandle = getDefaultAssistantHandle();

    expect(buildAssistantCapabilityContextForTargets([coreHandle])).toEqual(
      buildBuiltInAssistantPromptContextMetadata(
        [coreHandle],
        LOCAL_CAPABILITY_DEFINITIONS,
      ),
    );
  });

  it("ignores unknown feature assistant handles", () => {
    expect(buildAssistantCapabilityContextForTargets([])).toBeNull();
    expect(
      buildAssistantCapabilityContextForTargets(["fixture-not-registered"]),
    ).toBeNull();
  });
});
