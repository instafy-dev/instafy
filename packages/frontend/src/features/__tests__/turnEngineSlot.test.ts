import { describe, expect, it } from "vitest";
import { INSTAFY_FEATURE_MODULE_API_VERSION } from "@instafy/sdk/feature-modules";
import {
  createFrontendFeatureComposition,
  namesTurnEngineAccessMode,
  type FrontendFeatureModule,
} from "../frontendFeatureModule";
import { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } from "../publicCoreFrontendFeatureModule";
import { APPLICATION_FRONTEND_FEATURE_MODULES } from "../publicFrontendFeatureManifest";
import { CLAUDE_CODE_FRONTEND_FEATURE_MODULE } from "../claudeCode/claudeCodeFeatureModule";

describe("the turnEngines slot", () => {
  it("is empty for public core alone", () => {
    expect(createFrontendFeatureComposition([PUBLIC_CORE_FRONTEND_FEATURE_MODULE]).turnEngines).toEqual([]);
  });

  it("collects each module's engines and refuses a second engine with the same id", () => {
    const fixture: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.engine",
      turnEngines: [{ id: "fixture-engine" }],
    };
    expect(
      createFrontendFeatureComposition([PUBLIC_CORE_FRONTEND_FEATURE_MODULE, fixture]).turnEngines.map(
        (engine) => engine.id,
      ),
    ).toEqual(["fixture-engine"]);

    const duplicate: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.duplicate-engine",
      turnEngines: [{ id: "fixture-engine" }],
    };
    expect(() => createFrontendFeatureComposition([fixture, duplicate])).toThrow(
      'Duplicate frontend feature turn engine contribution id "fixture-engine".',
    );
  });

  it("lists the Claude Code module in the public manifest, beside public core", () => {
    expect(APPLICATION_FRONTEND_FEATURE_MODULES).toEqual([
      PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
      CLAUDE_CODE_FRONTEND_FEATURE_MODULE,
    ]);
    const composition = createFrontendFeatureComposition(APPLICATION_FRONTEND_FEATURE_MODULES);
    expect(composition.turnEngines.map((engine) => engine.id)).toEqual(["claude-code"]);
    // Studio's own start of a space where a turn of the person's waits (D44).
    expect(composition.studioRuntimeBridges.map((bridge) => bridge.id)).toEqual([
      "instafy.claude-code.start-for-waiting-turn",
    ]);
  });

  it("carries an engine's chat wording, its agent AI, its waiting note and its Your AI row in the contribution itself", () => {
    const [engine] = createFrontendFeatureComposition(APPLICATION_FRONTEND_FEATURE_MODULES).turnEngines;
    expect(engine?.presentation?.describeStart({ isViewer: true, name: null })).toBe(
      "Starting Claude Code on this computer…",
    );
    expect(engine?.presentation?.describeStart({ isViewer: false, name: "Sam" })).toBe(
      "Starting Claude Code on Sam's computer…",
    );
    expect(engine?.presentation?.describeWaiting({ isViewer: true, name: null }, [])).toBe(
      "Waiting for your computer…",
    );
    expect(engine?.presentation?.describeWaiting({ isViewer: false, name: "Sam" }, [])).toBe(
      "Waiting for Sam's computer…",
    );
    expect(engine?.agentAi?.label).toBe("Claude Code");
    expect(engine?.agentAi?.description).toBe(
      "Runs on your own Claude Code, on your computer. Its turns wait while your computer is off.",
    );
    expect(typeof engine?.WaitingNote).toBe("function");
    expect(typeof engine?.YourAiRow).toBe("function");
    // All of them are optional: an engine without them is still an engine.
    const bare: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.bare-engine",
      turnEngines: [{ id: "bare-engine" }],
    };
    const [bareEngine] = createFrontendFeatureComposition([bare]).turnEngines;
    expect(bareEngine?.presentation).toBeUndefined();
    expect(bareEngine?.agentAi).toBeUndefined();
    expect(bareEngine?.WaitingNote).toBeUndefined();
    expect(bareEngine?.YourAiRow).toBeUndefined();
  });

  it("offers Claude Code as an agent's AI only where the space's status says the switch covers the person", () => {
    const [engine] = createFrontendFeatureComposition(APPLICATION_FRONTEND_FEATURE_MODULES).turnEngines;
    const agentAi = engine?.agentAi;
    expect(agentAi?.offeredBy({ runtimes: [], preferredRuntimeId: null, claudeCodeLane: true })).toBe(true);
    expect(agentAi?.offeredBy({ runtimes: [], preferredRuntimeId: null })).toBe(false);
    expect(agentAi?.describeSaveRefusal({ code: "claude_code_turn_not_allowed", details: null })).toBe(
      "Claude Code turns aren't on for your account.",
    );
    expect(agentAi?.describeSaveRefusal({ code: "agent_handle_taken", details: null })).toBeNull();
  });
});

describe("turn-engine access modes", () => {
  // A build without an engine's module (the hosted Studio before it lists
  // one, or a tab opened before the deploy) still never sends that engine's
  // turns again by itself.
  it("counts any aiAccessMode but the runtime's own engine's, also of an engine this Studio was not built with", () => {
    expect(namesTurnEngineAccessMode({ aiAccessMode: "claude-code" })).toBe(true);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "future-engine" })).toBe(true);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "managed" })).toBe(false);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "byoc" })).toBe(false);
    expect(namesTurnEngineAccessMode({ aiAccessMode: " Managed " })).toBe(false);
    expect(namesTurnEngineAccessMode({ aiAccessMode: "   " })).toBe(false);
    expect(namesTurnEngineAccessMode({ aiAccessMode: 1 })).toBe(false);
    expect(namesTurnEngineAccessMode({ turnEngine: "claude-code" })).toBe(false);
    expect(namesTurnEngineAccessMode(["claude-code"])).toBe(false);
    expect(namesTurnEngineAccessMode(null)).toBe(false);
  });
});
