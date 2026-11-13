import { describe, expect, it } from "vitest";
import { INSTAFY_FEATURE_MODULE_API_VERSION } from "@instafy/sdk/feature-modules";
import {
  carriesTurnEngineClaim,
  createFrontendFeatureComposition,
  messageUsesTurnEngine,
  readTurnEngineClaim,
  withoutTurnEngineClaim,
  type FrontendFeatureModule,
} from "../frontendFeatureModule";
import { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } from "../publicCoreFrontendFeatureModule";
import { APPLICATION_FRONTEND_FEATURE_MODULES } from "../publicFrontendFeatureManifest";
import { CLAUDE_CODE_FRONTEND_FEATURE_MODULE } from "../claudeCode/claudeCodeFeatureModule";

function FixtureBridge() {
  return null;
}

describe("the turnEngines slot", () => {
  it("is empty for public core alone", () => {
    expect(createFrontendFeatureComposition([PUBLIC_CORE_FRONTEND_FEATURE_MODULE]).turnEngines).toEqual([]);
  });

  it("collects each module's engines and refuses a second engine with the same id", () => {
    const fixture: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.engine",
      turnEngines: [{ id: "fixture-engine", ComposerBridge: FixtureBridge }],
    };
    expect(
      createFrontendFeatureComposition([PUBLIC_CORE_FRONTEND_FEATURE_MODULE, fixture]).turnEngines.map(
        (engine) => engine.id,
      ),
    ).toEqual(["fixture-engine"]);

    const duplicate: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.duplicate-engine",
      turnEngines: [{ id: "fixture-engine", ComposerBridge: FixtureBridge }],
    };
    expect(() => createFrontendFeatureComposition([fixture, duplicate])).toThrow(
      'Duplicate frontend feature turn engine contribution id "fixture-engine".',
    );
  });

  it("refuses an engine without a composer bridge", () => {
    const broken = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.broken-engine",
      turnEngines: [{ id: "broken-engine", ComposerBridge: null }],
    } as unknown as FrontendFeatureModule;
    expect(() => createFrontendFeatureComposition([broken])).toThrow(
      'Frontend feature turn engine "broken-engine" requires a composer bridge.',
    );
  });

  it("lists the Claude Code module in the public manifest, beside public core", () => {
    expect(APPLICATION_FRONTEND_FEATURE_MODULES).toEqual([
      PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
      CLAUDE_CODE_FRONTEND_FEATURE_MODULE,
    ]);
    expect(
      createFrontendFeatureComposition(APPLICATION_FRONTEND_FEATURE_MODULES).turnEngines.map((engine) => engine.id),
    ).toEqual(["claude-code"]);
  });
});

describe("turn-engine claims", () => {
  it("reads only a non-empty string as a claim, and strips any value", () => {
    expect(readTurnEngineClaim({ turnEngine: "claude-code" })).toBe("claude-code");
    expect(readTurnEngineClaim({ turnEngine: "" })).toBeNull();
    expect(readTurnEngineClaim({ turnEngine: 1 })).toBeNull();
    expect(readTurnEngineClaim(null)).toBeNull();
    expect(carriesTurnEngineClaim({ turnEngine: 1 })).toBe(true);
    expect(carriesTurnEngineClaim({ turnEngine: null })).toBe(false);
    expect(carriesTurnEngineClaim({})).toBe(false);

    const unclaimed = { replyContext: { messageId: "m-1" } };
    expect(withoutTurnEngineClaim(unclaimed)).toBe(unclaimed);
    expect(withoutTurnEngineClaim({ turnEngine: "claude-code", input: { kind: "person" } })).toEqual({
      input: { kind: "person" },
    });
    expect(withoutTurnEngineClaim({ turnEngine: { nested: true } })).toEqual({});
    // The controller refuses a null claim, so the key goes whatever it holds.
    expect(withoutTurnEngineClaim({ turnEngine: null, input: null })).toEqual({ input: null });
    expect(withoutTurnEngineClaim(null)).toBeNull();
    expect(withoutTurnEngineClaim(undefined)).toBeNull();
  });

  it("knows the claim under the controller's other spelling too", () => {
    expect(readTurnEngineClaim({ turn_engine: "claude-code" })).toBe("claude-code");
    expect(carriesTurnEngineClaim({ turn_engine: "codex" })).toBe(true);
    expect(withoutTurnEngineClaim({ turn_engine: "claude-code", turnEngine: "claude-code", goal: 1 })).toEqual({
      goal: 1,
    });
  });

  it("knows a turn's messages by their claim or by the controller's aiAccessMode", () => {
    expect(messageUsesTurnEngine({ turnEngine: "claude-code" }, [])).toBe(true);
    expect(messageUsesTurnEngine({ aiAccessMode: "claude-code" }, ["claude-code"])).toBe(true);
    expect(messageUsesTurnEngine({ aiAccessMode: "claude-code" }, [])).toBe(false);
    expect(messageUsesTurnEngine({ aiAccessMode: "managed" }, ["claude-code"])).toBe(false);
    expect(messageUsesTurnEngine(null, ["claude-code"])).toBe(false);
  });
});
