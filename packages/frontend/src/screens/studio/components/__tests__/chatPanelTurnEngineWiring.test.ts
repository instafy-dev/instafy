import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What ChatPanel wires for turn-engine turns (docs/Local-Engine-Turns.md
 * 5.5-5.7). ChatPanel is wired to a dozen providers, so mounting it in jsdom
 * is not practical (see chatPanelRunTraceAutoRetry.test.ts). These assertions
 * read the source; useRunFailureRetryActionsTurnEngine.test.tsx,
 * useChatSubmitDispatch.test.tsx and runtimeAlertPresentation.test.ts cover
 * what each piece does.
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
  it("gives a failed turn-engine turn its sender's name and the way back to the composer", () => {
    const retryActions = callArguments(chatPanel, "useRunFailureRetryActions");
    expect(retryActions).toContain("humanLabelByUserId,");
    // Only where an engine is offered: outside Desktop the card offers nothing.
    expect(retryActions).toMatch(
      /refillComposerWithTurnEngine:\s*Object\.keys\(turnEngineOffers\)\.length > 0 \? refillComposerWithTurnEngine : undefined/,
    );
    // The names are worked out before the hook reads them.
    const names = chatPanel.indexOf("const humanLabelByUserId = useMemo");
    expect(names).toBeGreaterThan(-1);
    expect(names).toBeLessThan(chatPanel.indexOf("useRunFailureRetryActions({"));
    expect(chatPanel.indexOf("const humanLabelByUserId = useMemo", names + 1)).toBe(-1);
  });

  it("puts the words back above the draft and chooses the engine only while it is offered, sending nothing", () => {
    const refill = between(
      chatPanel,
      "const refillComposerWithTurnEngine = useCallback(",
      "const runFailureRetryContextValue",
    );
    expect(refill).toContain("composerTextWithDraftRestored(text, latestInputValueRef.current");
    expect(refill).toContain("onInputChange(activeConversationId, refilled, null);");
    expect(refill).toMatch(/if \(turnEngineOffers\[turnEngine\]\) \{\s*setPendingTurnEngineId\(turnEngine\);/);
    expect(refill).toContain("showStatus(TURN_ENGINE_UNAVAILABLE_NOTICE");
    expect(refill).not.toMatch(/invokeSubmitMessage|submitMessage|performSubmit/);
  });

  it("keeps a turn engine's reply header, with its line, at every width in the run trace", () => {
    // Elsewhere the trace shows an assistant's header only where the gutter
    // face is gone, which would leave the line out on a wide screen.
    const trace = between(chatPanel, "if (normalizedJobThread) {", "Read-only run trace");
    expect(trace).toContain(
      "const assistantHeaderEverywhere = showsAssistantHeader && showsTurnEngineSpeakerLine(messageMetadata);",
    );
    expect(trace).toContain(
      "speakerIdentity={assistantHeaderEverywhere ? assistantSpeakerIdentity : humanSpeakerIdentity}",
    );
    expect(trace).toContain("narrowSpeakerIdentity={assistantHeaderEverywhere ? null : assistantSpeakerIdentity}");
  });

  // docs/Local-Engine-Turns.md 5.2: only the composer's own Send of the
  // draft it shows carries the engine chosen for the next message. Neither
  // the controller nor the runtime can tell Instafy's words from the
  // person's once they carry the claim, so this gate is the one that holds.
  it("lets only the composer's own Send carry the chosen engine, by its caller's override", () => {
    const submit = between(
      chatPanel,
      "const invokeSubmitMessage = useCallback<SubmitMessageFn>(async (override, options) => {",
      "const removed = await removeServerMessageStash(restoredStash.id);",
    );
    // A restored stash is sent with an override the panel builds itself:
    // the caller's own override decides.
    expect(submit).toContain("const restoredStash = override ? null : restoredMessageStash;");
    expect(submit).toMatch(
      /const composerTurnEngine = composerTurnEngineFor\(\{\s*override,\s*automatic,\s*pendingEngineId: pendingTurnEngineIdRef\.current,\s*\}\);/,
    );
    expect(submit).toContain(
      "composerTurnEngine ? { ...nextOptions, turnEngine: composerTurnEngine } : nextOptions,",
    );
    // Nothing else in the panel hands a submit an engine: the only other
    // `turnEngine:` is the type of the refill's input.
    expect([...chatPanel.matchAll(/\bturnEngine:\s*([A-Za-z]+)/g)].map((match) => match[1]).sort()).toEqual([
      "composerTurnEngine",
      "string",
    ]);
  });

  it("sends Instafy's own words and every automatic send through an override or as automatic", () => {
    // An undo, the goal's help prompt and a selection reply pass their words.
    expect(chatPanel).toContain("invokeSubmitMessage({ message, editorState: null, metadata }),");
    const goalHelp = between(chatPanel, "const handleHelpUnblockGoal = useCallback(() => {", "const handleSubmit = ");
    expect(goalHelp).toMatch(/void invokeSubmitMessage\(\{\s*message: prompt,\s*editorState: null,\s*\}\);/);
    expect(chatPanel).toMatch(
      /void invokeSubmitMessage\(\{\s*message: nextValue,\s*editorState: null,\s*metadata: \{ replyContext: context \},\s*\}\);/,
    );
    // A site's ask sends automatically, with its own words (siteAsks.ts).
    expect(chatPanel).toContain("const sendSiteAsk = useMemo(() => composerAskSender(invokeSubmitMessage), [invokeSubmitMessage]);");
    // Try again always passes the prompt's words (useRunFailureRetryActions).
    expect(callArguments(chatPanel, "useRunFailureRetryActions")).toContain("submit: invokeSubmitMessage,");
  });

  it("refuses to queue a message that claims an engine, before anything is kept", () => {
    const enqueue = between(chatPanel, "const enqueueChatSendQueueItem = useCallback(", "setChatSendQueueExpanded(false);");
    const refusal = enqueue.indexOf("if (carriesTurnEngineClaim(payload.metadata)) {");
    expect(refusal).toBeGreaterThan(-1);
    expect(enqueue.slice(refusal, enqueue.indexOf("}", refusal))).toContain("return;");
    expect(refusal).toBeLessThan(enqueue.indexOf("setChatSendQueue("));
  });

  it("drops the choice with the chat, the space, the engine's offer and a stash, and uses it once", () => {
    expect(chatPanel).toMatch(
      /useEffect\(\(\) => \{\s*setPendingTurnEngineId\(null\);\s*\}, \[activeConversationId, activeProjectId\]\);/,
    );
    expect(chatPanel).toMatch(
      /if \(pendingTurnEngineId && !turnEngineOffers\[pendingTurnEngineId\]\) \{\s*setPendingTurnEngineId\(null\);/,
    );
    const stash = between(chatPanel, "const handleStashDraft = useCallback(", 'showStatus("Draft stashed privately."');
    expect(stash).toContain("setPendingTurnEngineId(null);");
    // Used up only for the engine it was chosen for, and only by the submit
    // flow, which does that once a routed send went out.
    expect(chatPanel).toMatch(
      /const consumeTurnEngineChoice = useCallback\(\(engineId: string\) => \{\s*setPendingTurnEngineId\(\(current\) => \(current === engineId \? null : current\)\);/,
    );
    expect(callArguments(chatPanel, "useChatSubmitFlow")).toContain("consumeTurnEngineChoice,");
  });

  it("leaves a dictated turn in the composer while an engine is chosen, for the person's own Send", () => {
    expect(chatPanel).toContain("const turnEngineChosen = pendingTurnEngineId !== null;");
    expect(callArguments(chatPanel, "useChatVoiceComposerController")).toContain(
      "manualSubmitOnly: Boolean(workerQuestionReply.active) || turnEngineChosen,",
    );
  });

  it("sends nothing to a model for ghost text while an engine is chosen", () => {
    const effect = between(chatPanel, "!shouldRequestComposerInlineCompletion({", "onGithubImportSuccessRef.current");
    expect(effect).toContain("turnEnginePending: turnEngineChosen,");
    // The effect runs again when the choice changes, and clears any ghost text.
    expect(effect).toMatch(/sendingAttachment,\s*turnEngineChosen,\s*\]\);/);
  });

  it("never sends the draft from the AI wizard while an engine is chosen", () => {
    const keepDraft =
      /if \(pendingTurnEngineIdRef\.current !== null\) \{\s*return;\s*\}\s*void submitMessage\(undefined, \{ allowWhileBusy: true \}\);/;
    expect(between(chatPanel, "if (!pendingCredentialAutoSubmitRef.current) {", "const handleUseManagedAi")).toMatch(
      keepDraft,
    );
    expect(between(chatPanel, "const handleUseManagedAi = useCallback(() => {", "const handleChatWithoutAi")).toMatch(
      keepDraft,
    );
  });

  // newestTurnEngineStartingLine (runFailurePresentationTurnEngine.test.ts)
  // words it for the sender and for a teammate.
  it("words a turn-engine turn's start in the typing row, for one agent and for whoever views it", () => {
    expect(callArguments(chatPanel, "resolveAgentWaitingActivityCopy")).toContain(
      "turnEngineStartingLine: typingTurnEngineStartingLine",
    );
    const startingLine = between(chatPanel, "const typingTurnEngineStartingLine = useMemo(", "const waitingActivityCopy");
    expect(startingLine).toContain("isAssistantTyping && !hasMultipleTypingAgents");
    expect(startingLine).toMatch(
      /newestTurnEngineStartingLine\(\{\s*conversationMessages: messages,\s*run: activeConversationRun,\s*viewer: \{ currentUserId, nameOf: \(userId\) => humanLabelByUserId\.get\(userId\) \},\s*\}\)/,
    );
    // The viewer and the names are worked out before the typing row reads them.
    expect(chatPanel.indexOf("const currentUserId = ")).toBeLessThan(chatPanel.indexOf("const typingTurnEngineStartingLine"));
    expect(chatPanel.indexOf("const humanLabelByUserId = useMemo")).toBeLessThan(
      chatPanel.indexOf("const typingTurnEngineStartingLine"),
    );
  });
});
