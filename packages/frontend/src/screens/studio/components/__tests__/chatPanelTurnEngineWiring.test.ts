import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What ChatPanel wires for turn-engine turns (docs/Local-Engine-Turns.md
 * 5.5-5.7, 11.14). ChatPanel is wired to a dozen providers, so mounting it in
 * jsdom is not practical (see chatPanelRunTraceAutoRetry.test.ts). These
 * assertions read the source; useRunFailureRetryActionsTurnEngine.test.tsx,
 * runFailurePresentationTurnEngine.test.ts, ChatTypingRows.test.tsx and
 * runtimeAlertPresentation.test.ts cover what each piece does.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function callArguments(source: string, callee: string): string {
  const start = source.indexOf(`${callee}({`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ChatPanel's turn-engine wiring", () => {
  it("gives a failed turn-engine turn the name of its person, by its run or its prompt", () => {
    const retryActions = callArguments(chatPanel, "useRunFailureRetryActions");
    expect(retryActions).toContain("humanLabelByUserId,");
    expect(retryActions).toContain("runs,");
    // The names are worked out before the hook reads them.
    const names = chatPanel.indexOf("const humanLabelByUserId = useMemo");
    expect(names).toBeGreaterThan(-1);
    expect(names).toBeLessThan(chatPanel.indexOf("useRunFailureRetryActions({"));
    expect(chatPanel.indexOf("const humanLabelByUserId = useMemo", names + 1)).toBe(-1);
  });

  it("keeps a turn engine's reply header, with its line, at every width in the run trace", () => {
    // Elsewhere the trace shows an assistant's header only where the gutter
    // face is gone, which would leave the line out on a wide screen.
    const trace = between(chatPanel, "if (normalizedJobThread) {", "Read-only run trace");
    // So does a reply that names the viewer's own sign-in it ran on (11.20).
    expect(trace).toMatch(
      /const assistantHeaderEverywhere =\s*showsAssistantHeader &&\s*\(showsTurnEngineSpeakerLine\(messageMetadata\) \|\| showsSignInLineInTrace\(messageMetadata\)\);/,
    );
    const gate = chatPanel.indexOf("const showsSignInLineInTrace = useReplySignInLineGate(jobThreadMessages);");
    expect(gate).toBeGreaterThan(chatPanel.indexOf("const jobThreadMessages = useMemo"));
    expect(gate).toBeLessThan(chatPanel.indexOf("if (normalizedJobThread) {"));
    expect(trace).toContain(
      "speakerIdentity={assistantHeaderEverywhere ? assistantSpeakerIdentity : humanSpeakerIdentity}",
    );
    expect(trace).toContain("narrowSpeakerIdentity={assistantHeaderEverywhere ? null : assistantSpeakerIdentity}");
  });

  // docs/Local-Engine-Turns.md 11.3: an agent's AI decides; the composer
  // offers no choice for one message, and nothing it sends names an engine.
  it("offers no per-message choice of engine, and no send names one", () => {
    expect(chatPanel).not.toMatch(/turnEngineOffers|pendingTurnEngine|ComposerBridge|turnEngineChosen/);
    expect(chatPanel).not.toMatch(/\bturnEngine:/);
    expect(callArguments(chatPanel, "useChatVoiceComposerController")).toContain(
      "manualSubmitOnly: Boolean(workerQuestionReply.active),",
    );
  });

  // newestTurnEngineStartingLine (runFailurePresentationTurnEngine.test.ts)
  // words it for the turn's person and for a teammate, while it waits and once it starts.
  it("words a turn-engine turn's wait and start in the typing row, for one agent and for whoever views it", () => {
    expect(callArguments(chatPanel, "resolveAgentWaitingActivityCopy")).toContain(
      "turnEngineStartingLine: typingTurnEngineStartingLine",
    );
    const startingLine = between(chatPanel, "const typingTurnEngineStartingLine = useMemo(", "const waitingTurnEngine");
    // From the press of Send, as the typing row it words (chatPanelTypingRowWiring.test.ts).
    expect(startingLine).toContain("assistantTurnPending && !hasMultipleTypingAgents");
    expect(startingLine).toMatch(
      /newestTurnEngineStartingLine\(\{\s*conversationMessages: messages,\s*run: activeConversationRun,\s*viewer: \{ currentUserId, nameOf: \(userId\) => humanLabelByUserId\.get\(userId\) \},\s*runtimes: runtimeStatuses,\s*\}\)/,
    );
    // The viewer and the names are worked out before the typing row reads them.
    expect(chatPanel.indexOf("const currentUserId = ")).toBeLessThan(chatPanel.indexOf("const typingTurnEngineStartingLine"));
    expect(chatPanel.indexOf("const humanLabelByUserId = useMemo")).toBeLessThan(
      chatPanel.indexOf("const typingTurnEngineStartingLine"),
    );
  });

  // 11.14: under a waiting turn of the viewer's own, what makes it run, as
  // its engine words it, with the same Start as the connect dialog's.
  it("puts the engine's note under the typing row of the viewer's own waiting turn, with the space's Start", () => {
    const note = between(chatPanel, "const waitingTurnEngine = useMemo(", "const waitingActivityCopy");
    expect(note).toMatch(/newestWaitingTurnEngine\(\{\s*conversationMessages: messages,\s*run: activeConversationRun,/);
    expect(note).toContain("waitingTurnEngine?.owner?.isViewer");
    expect(note).toContain(
      "registeredTurnEngines().find((engine) => engine.id === waitingTurnEngine.engineId)?.WaitingNote",
    );
    expect(note).toContain("const spaceStartOnThisComputer = useStartSpaceOnThisComputer();");
    expect(note).toContain("startOnThisComputer={startWaitingTurnSpaceHere}");
    expect(note).toContain("runtimes={runtimeStatuses}");
    expect(chatPanel).toContain("typingStatusNote={typingStatusNote}");
  });

  // 11.3: an agent whose AI is a turn engine shows it by name in the
  // participants drawer, with no model, effort or credential of Instafy's.
  it("names a turn engine agent's AI in the participants drawer", () => {
    const participants = between(
      chatPanel,
      "const participantAgents = useMemo<ParticipantAgent[]>(() => {",
      "participantAgentsHaveCredentialWarning",
    );
    expect(participants).toContain("const engineAi = profile ? turnEngineAgentAiOf(profile.provider) : null;");
    expect(participants).toMatch(/aiLabel: engineAi\.agentAi\.label,/);
    expect(participants).toMatch(/model: null,\s*modelLabel: null,\s*reasoningEffort: null,/);
  });
});
