import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Core code words turn-engine turns from the registry the application's
 * composition fills (features/turnEngineRegistry.ts), so it never imports that
 * composition, whose virtual feature manifest only the application's Vite
 * configurations resolve. The browser-component lane (vite.ci-ui.config.ts)
 * mounts core components without one.
 */
describe("the turn-engine registry", () => {
  it("holds no engine until the application's composition registers its own", async () => {
    const { registeredTurnEngines } = await import("../turnEngineRegistry");
    expect(registeredTurnEngines()).toEqual([]);

    const { APPLICATION_FRONTEND_FEATURES } = await import("../applicationFrontendFeatureComposition");
    expect(APPLICATION_FRONTEND_FEATURES.turnEngines.length).toBeGreaterThan(0);
    expect(registeredTurnEngines().map((engine) => engine.id)).toEqual(
      APPLICATION_FRONTEND_FEATURES.turnEngines.map((engine) => engine.id),
    );
  });

  it("keeps the core run-failure presentation off the application's composition", () => {
    const source = fs.readFileSync(path.join(sourceRoot, "conversations/runFailurePresentation.ts"), "utf8");
    expect(source).not.toContain("applicationFrontendFeatureComposition");
    expect(source).toContain('from "../features/turnEngineRegistry"');
  });
});
