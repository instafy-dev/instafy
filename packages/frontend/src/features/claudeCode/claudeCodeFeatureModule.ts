import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  defineInstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import type {
  FrontendFeatureModule,
  FrontendTurnEngineContribution,
} from "../frontendFeatureModule";
import { ClaudeCodeComposerBridge } from "./ClaudeCodeComposerBridge";
import { ClaudeCodeYourAiRow } from "./ClaudeCodeYourAiRow";
import { CLAUDE_CODE_TURN_ENGINE_ID } from "./claudeCodeComposer";
import { CLAUDE_CODE_TURN_PRESENTATION } from "./claudeCodeTurnPresentation";

/**
 * One @octo turn on the person's own Claude Code, on the computer they are
 * using (docs/Local-Engine-Turns.md, section 5). It ships dark: the
 * controller's switch covers nobody, so the composer offers nothing until a
 * release turns it on. Its turns' words in the chat (5.5-5.7) and its Your AI
 * row (5.3) come from here too.
 */
export const CLAUDE_CODE_TURN_ENGINE: FrontendTurnEngineContribution = Object.freeze({
  id: CLAUDE_CODE_TURN_ENGINE_ID,
  ComposerBridge: ClaudeCodeComposerBridge,
  presentation: CLAUDE_CODE_TURN_PRESENTATION,
  YourAiRow: ClaudeCodeYourAiRow,
});

export const CLAUDE_CODE_FRONTEND_FEATURE_MODULE: FrontendFeatureModule =
  defineInstafyFeatureModule({
    apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
    id: "instafy.claude-code",
    turnEngines: [CLAUDE_CODE_TURN_ENGINE],
  });
