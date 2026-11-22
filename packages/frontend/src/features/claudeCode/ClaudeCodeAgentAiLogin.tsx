import { useId } from "react";
import { Field } from "../../components/Field";
import { Select } from "../../components/Select";
import type {
  FrontendTurnEngineAgentAiFieldsProps,
  FrontendTurnEngineAgentAiLabelProps,
} from "../frontendFeatureModule";
import { CLAUDE_CODE_COPY } from "./claudeCodeCopy";
import { claudeCodeLoginLabel, useClaudeCodeLogins, type ClaudeCodeLogin } from "./claudeCodeLoginsStore";

const COPY = CLAUDE_CODE_COPY.agentAi;

/**
 * The login an agent's turns run on (docs/Local-Engine-Turns.md 11.19): the
 * one it names when that is still one of the person's, else their first
 * login, which an agent that names none uses.
 */
function effectiveLoginId(logins: readonly ClaudeCodeLogin[], named: string | null | undefined): string | null {
  const id = named?.toLowerCase() ?? null;
  return (id && logins.some((login) => login.id === id) ? id : logins[0]?.id) ?? null;
}

/**
 * The agent editor's **Login** choice while Claude Code is the agent's AI
 * (docs/Settings-UI.md, Bot profiles): the person's logins by name, the
 * oldest marked "(first login)", for a person with more than one; with one or
 * none it shows nothing. Choosing sets `claudeCodeLoginId`, null for the first
 * login, so an agent on it follows whichever login is first.
 */
export function ClaudeCodeAgentAiLogin({ agent, fields, onFieldsChange, disabled }: FrontendTurnEngineAgentAiFieldsProps) {
  // Read each time the editor opens: a login added on another computer shows.
  const logins = useClaudeCodeLogins(0);
  const id = useId();
  if (!logins || logins.length < 2) {
    return null;
  }
  const chosen =
    fields && "claudeCodeLoginId" in fields ? fields.claudeCodeLoginId ?? null : agent?.claudeCodeLoginId ?? null;
  const value = effectiveLoginId(logins, chosen) ?? "";
  const firstLoginId = logins[0]?.id ?? null;
  return (
    <Field label={COPY.login} htmlFor={id}>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        data-testid="agent-profile-claude-code-login"
        onChange={(event) => {
          const next = event.target.value;
          if (!logins.some((login) => login.id === next)) {
            return;
          }
          onFieldsChange({ claudeCodeLoginId: next === firstLoginId ? null : next });
        }}
      >
        {logins.map((login, index) => (
          <option key={login.id} value={login.id}>
            {index === 0 ? `${login.label} ${COPY.firstLogin}` : login.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Claude Code's name in a list of agents: "Claude Code (Work)" for an agent
 * that names one of the person's logins while they have more than one, else
 * "Claude Code" (docs/Settings-UI.md, Bot profiles). Only the person's own
 * logins are named, and only to them: the list is their own agents'.
 */
export function ClaudeCodeAgentAiLabel({ agent }: FrontendTurnEngineAgentAiLabelProps) {
  const logins = useClaudeCodeLogins();
  const label = logins && logins.length > 1 ? claudeCodeLoginLabel(logins, agent.claudeCodeLoginId) : null;
  return <>{label ? `${COPY.label} (${label})` : COPY.label}</>;
}
