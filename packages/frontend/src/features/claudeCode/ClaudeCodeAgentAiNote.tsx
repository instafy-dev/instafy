import { useEffect, useRef, useState } from "react";
import { Text } from "../../components/Text";
import type { FrontendTurnEngineAgentAiNoteProps } from "../frontendFeatureModule";
import { CLAUDE_CODE_COPY } from "./claudeCodeCopy";
import { claudeCodeDesktopHostAvailable, readClaudeCodeDesktopStatus } from "./claudeCodeDesktop";

/**
 * Under Claude Code in the agent editor (docs/Local-Engine-Turns.md 11.3,
 * 11.14): in Instafy Desktop, on a computer where Claude Code can run but
 * isn't set up, where to set it up, Your AI's "Claude Code on this computer".
 * An agent can use Claude Code before any computer is set up; its turns wait
 * until one is. Anywhere else it says nothing.
 */
export function ClaudeCodeAgentAiNote({ resolveControllerUrl }: FrontendTurnEngineAgentAiNoteProps) {
  const [notSetUpHere, setNotSetUpHere] = useState(false);
  const resolveControllerUrlRef = useRef(resolveControllerUrl);
  resolveControllerUrlRef.current = resolveControllerUrl;

  useEffect(() => {
    if (!claudeCodeDesktopHostAvailable()) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const controllerUrl = await resolveControllerUrlRef.current().catch(() => null);
      const desktop = await readClaudeCodeDesktopStatus(controllerUrl);
      if (!cancelled) {
        setNotSetUpHere(Boolean(desktop?.supported && !desktop.consented));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!notSetUpHere) {
    return null;
  }
  return (
    <Text as="p" variant="caption" tone="muted" data-testid="agent-profile-claude-code-set-up">
      {CLAUDE_CODE_COPY.agentAi.setUpHere}
    </Text>
  );
}
