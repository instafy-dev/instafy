import type { ControllerAgentProfile } from "@instafy/sdk/agents";
import type { FrontendTurnEngineSignIns, TurnEngineAgentAiRequestFields } from "../frontendFeatureModule";
import {
  claudeCodeLoginsSnapshot,
  ensureClaudeCodeLogins,
  subscribeClaudeCodeLogins,
  type ClaudeCodeLogin,
} from "./claudeCodeLoginsStore";

/**
 * The key that names one of the person's Claude Code logins as a sign-in
 * (docs/Local-Engine-Turns.md 11.20): in an agent's `backupAis`, and in the
 * `aiSignIn` and `aiSignInNext` stamps of a turn's messages.
 */
export const CLAUDE_CODE_LOGIN_SIGN_IN_KEY = "claudeCodeLoginId";

/**
 * The login an agent's turns run on (11.19): the one it names when that is
 * still one of the person's, else their first login, which an agent that
 * names none uses.
 */
export function effectiveClaudeCodeLoginId(
  logins: readonly ClaudeCodeLogin[],
  named: string | null | undefined,
): string | null {
  const id = named?.toLowerCase() ?? null;
  return (id && logins.some((login) => login.id === id) ? id : logins[0]?.id) ?? null;
}

/** The login the editor's draft names: what its Login choice set, else what the agent saved. */
export function draftClaudeCodeLoginId(
  agent: ControllerAgentProfile | null,
  fields: TurnEngineAgentAiRequestFields | null,
): string | null {
  return fields && "claudeCodeLoginId" in fields ? fields.claudeCodeLoginId ?? null : agent?.claudeCodeLoginId ?? null;
}

/**
 * The person's Claude Code logins as sign-ins (11.20), from the one store the
 * Your AI row, the agent editor, the agents list and the chat share: Backups
 * offers them by name, and the chat names the one a turn ran on for its
 * owner alone. The agent's own login, a backup never is.
 */
export const CLAUDE_CODE_SIGN_INS: FrontendTurnEngineSignIns = Object.freeze({
  refKey: CLAUDE_CODE_LOGIN_SIGN_IN_KEY,
  snapshot: claudeCodeLoginsSnapshot,
  subscribe: subscribeClaudeCodeLogins,
  load: (maxAgeMs?: number) => ensureClaudeCodeLogins(maxAgeMs),
  firstForAgent: ({ agent, fields }: { agent: ControllerAgentProfile | null; fields: TurnEngineAgentAiRequestFields | null }) => {
    const logins = claudeCodeLoginsSnapshot();
    return logins ? effectiveClaudeCodeLoginId(logins, draftClaudeCodeLoginId(agent, fields)) : null;
  },
});
