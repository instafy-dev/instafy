import { createElement } from "react";
import { Laptop } from "iconoir-react";
import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  defineInstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import type {
  FrontendFeatureModule,
  FrontendTurnEngineAgentAi,
  FrontendTurnEngineContribution,
} from "../frontendFeatureModule";
import type { FetchRuntimeStatusResult } from "../../services/runtimeController/runtimes";
import { ClaudeCodeAgentAiNote } from "./ClaudeCodeAgentAiNote";
import { ClaudeCodeAutoStart } from "./ClaudeCodeAutoStart";
import { ClaudeCodeWaitingNote } from "./ClaudeCodeWaitingNote";
import { ClaudeCodeYourAiRow } from "./ClaudeCodeYourAiRow";
import { CLAUDE_CODE_COPY } from "./claudeCodeCopy";
import {
  CLAUDE_CODE_TURN_ENGINE_ID,
  CLAUDE_CODE_TURN_NOT_ALLOWED_CODE,
  CLAUDE_CODE_TURN_PRESENTATION,
} from "./claudeCodeTurnPresentation";

/**
 * Claude Code as an agent's AI (docs/Local-Engine-Turns.md 11.3): offered in
 * the agent editor only to a person the controller's switch covers, which the
 * open space's runtime status says (`claudeCodeLane`, 2.10).
 */
export const CLAUDE_CODE_AGENT_AI: FrontendTurnEngineAgentAi = Object.freeze({
  label: CLAUDE_CODE_COPY.agentAi.label,
  // The computer it runs on: there is no Anthropic logo (D28).
  icon: createElement(Laptop, { className: "h-4 w-4", "aria-hidden": true }),
  description: CLAUDE_CODE_COPY.agentAi.description,
  offeredBy: (status: FetchRuntimeStatusResult) => status.claudeCodeLane === true,
  describeSaveRefusal: ({ code }: { code: string; details: unknown }) =>
    code.trim() === CLAUDE_CODE_TURN_NOT_ALLOWED_CODE ? CLAUDE_CODE_COPY.agentAi.notAllowed : null,
  Note: ClaudeCodeAgentAiNote,
});

/**
 * Every turn of an agent whose AI is Claude Code runs on its owner's own
 * Claude Code, on their computer (docs/Local-Engine-Turns.md 11.3-11.14). It
 * ships dark: the controller's switch covers nobody, so no agent editor offers
 * it until a release turns it on. Its turns' words in the chat (5.5-5.7,
 * 11.14), its Your AI row (5.3) and Studio's start of a space where a turn of
 * the person's waits (D44) come from here too.
 */
export const CLAUDE_CODE_TURN_ENGINE: FrontendTurnEngineContribution = Object.freeze({
  id: CLAUDE_CODE_TURN_ENGINE_ID,
  presentation: CLAUDE_CODE_TURN_PRESENTATION,
  agentAi: CLAUDE_CODE_AGENT_AI,
  WaitingNote: ClaudeCodeWaitingNote,
  YourAiRow: ClaudeCodeYourAiRow,
});

export const CLAUDE_CODE_FRONTEND_FEATURE_MODULE: FrontendFeatureModule =
  defineInstafyFeatureModule({
    apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
    id: "instafy.claude-code",
    turnEngines: [CLAUDE_CODE_TURN_ENGINE],
    studioRuntimeBridges: [{ id: "instafy.claude-code.start-for-waiting-turn", component: ClaudeCodeAutoStart }],
  });
