import { describe, expect, it } from "vitest";
import { INSTAFY_FEATURE_MODULE_API_VERSION } from "@instafy/sdk/feature-modules";
import {
  carriesTurnEngineClaim,
  createFrontendFeatureComposition,
  messageUsesTurnEngine,
  namesTurnEngineAccessMode,
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

  it("carries an engine's chat wording and its Your AI row in the contribution itself", () => {
    const [engine] = createFrontendFeatureComposition(APPLICATION_FRONTEND_FEATURE_MODULES).turnEngines;
    expect(engine?.presentation?.describeStart({ isViewer: true, name: null })).toBe(
      "Starting Claude Code on this computer…",
    );
    expect(engine?.presentation?.describeStart({ isViewer: false, name: "Sam" })).toBe(
      "Starting Claude Code on Sam's computer…",
    );
    expect(engine?.presentation?.resendLabel).toBe("Send again with Claude Code");
    expect(typeof engine?.YourAiRow).toBe("function");
    // Both are optional: an engine without them is still an engine.
    const bare: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.bare-engine",
      turnEngines: [{ id: "bare-engine", ComposerBridge: FixtureBridge }],
    };
    const [bareEngine] = createFrontendFeatureComposition([bare]).turnEngines;
    expect(bareEngine?.presentation).toBeUndefined();
    expect(bareEngine?.YourAiRow).toBeUndefined();
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
    expect(messageUsesTurnEngine({ turnEngine: "claude-code" })).toBe(true);
    expect(messageUsesTurnEngine({ turn_engine: "future-engine" })).toBe(true);
    expect(messageUsesTurnEngine({ aiAccessMode: "claude-code" })).toBe(true);
    expect(messageUsesTurnEngine({ aiAccessMode: "managed" })).toBe(false);
    expect(messageUsesTurnEngine({ aiAccessMode: "byoc" })).toBe(false);
    expect(messageUsesTurnEngine({ aiAccessMode: " Managed " })).toBe(false);
    expect(messageUsesTurnEngine({ aiAccessMode: "" })).toBe(false);
    expect(messageUsesTurnEngine({ aiAccessMode: 1 })).toBe(false);
    expect(messageUsesTurnEngine(null)).toBe(false);
  });

  // A build without an engine's module (the hosted Studio before it lists
  // one, or a tab opened before the deploy) still never retries, resends or
  // titles from that engine's turns.
  it("counts any aiAccessMode but the runtime's own engine's, also of an engine this Studio was not built with", () => {
    expect(namesTurnEngineAccessMode({ aiAccessMode: "future-engine" })).toBe(true);
    expect(messageUsesTurnEngine({ aiAccessMode: "future-engine" })).toBe(true);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "managed" })).toBe(false);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "byoc" })).toBe(false);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "   " })).toBe(false);
    expect(namesTurnEngineAccessMode({ turnEngine: "claude-code" })).toBe(false);
    expect(namesTurnEngineAccessMode(["claude-code"])).toBe(false);
  });
});
