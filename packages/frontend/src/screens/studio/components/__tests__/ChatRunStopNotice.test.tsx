// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationMessage } from "../../../../conversations/conversationSubmitHelpers";
import {
  forgetPromptsSentFromThisPageForTests,
  recordSendFailedForPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../../types";
import { browserHandBackRetry } from "../useBrowserHandBack";
import { ChatRunStopNotice, ChatRunStopNoticeProvider, stoppedByWords } from "../ChatRunStopNotice";
import { useChatRunStopContinuation } from "../useChatRunStopContinuation";
import type { SubmitMessageFn } from "../useChatSubmitFlow";

const WARRANTY = "Add each laptop's warranty from its own page.";
// The person's message whose turn the Stop ended.
const asked: ChatMessage = {
  id: "asked-1", role: "user", authorId: "viewer", content: WARRANTY, timestamp: 0, files: null,
  metadata: { runId: "run-1" },
};
const notice: ChatMessage = {
  id: "stop-1", role: "assistant", authorId: null, content: "", timestamp: 1, files: null,
  messageType: "run_cancellation", metadata: { details: {
    stopRequested: true, actorUserId: "viewer", agentHandles: ["octo", "scribe"],
    jobIds: ["job-1", "job-2"], runIds: ["run-1", "run-2"],
  } },
};

describe("persisted run stop notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controls: ReturnType<typeof useChatRunStopContinuation>;
  const submit = vi.fn<SubmitMessageFn>();
  let props: Parameters<typeof useChatRunStopContinuation>[0];
  function Harness() {
    controls = useChatRunStopContinuation(props);
    return <ChatRunStopNoticeProvider value={controls}><ChatRunStopNotice message={notice} /></ChatRunStopNoticeProvider>;
  }
  async function render(next: Partial<typeof props> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    submit.mockReset();
    props = { conversationId: "chat", viewerUserId: "viewer", humanLabelByUserId: new Map(), canWrite: true,
      busy: false, messages: [asked, notice], hasNewer: false, queuedSends: [], submitMessage: submit };
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  // The row of a stopped turn says "Stopped" itself: who stopped it is named
  // only when it was someone else. Continue carries on the request in its own
  // words, so it is only for the person who asked it.
  it("names who stopped the turn only when it was someone else", async () => {
    expect(stoppedByWords(notice, "viewer")).toBeNull();
    expect(stoppedByWords(notice, "other", new Map([["viewer", "Alex"]]))).toBe("Alex stopped this");
    expect(stoppedByWords(notice, "other")).toBe("A teammate stopped this");
    expect(stoppedByWords({ ...notice, metadata: null }, "viewer")).toBeNull();
    // A turn stopped before it showed anything has only this row: it says Stopped.
    await render();
    expect(container.textContent).toBe("StoppedContinue");
    await render({ viewerUserId: "other", humanLabelByUserId: new Map([["viewer", "Alex"]]) });
    expect(container.textContent).toBe("StoppedAlex stopped this");
  });
  // A local test, Nov 8: Continue sent "Continue the stopped turn from its current
  // state. …" as the person's message; the routing step sent it to the browser
  // again, and History named the save with it.
  it("carries the stopped request on in its own words, once, preserving the draft", async () => {
    submit.mockResolvedValue(true); await render();
    await act(async () => { await controls!.onContinue(notice); await controls!.onContinue(notice); });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      message: WARRANTY,
      editorState: null,
      targetAgentHandles: ["octo", "scribe"],
      metadata: { continuedStopMessageId: "stop-1", continuedRunIds: ["run-1", "run-2"] },
    }, expect.objectContaining({ automatic: true, intent: "send" }));
  });
  it("hides Continue while busy or read-only and rechecks capability on activation", async () => {
    await render({ busy: true }); expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).toBeNull();
    await render({ busy: false, canWrite: false }); await controls!.onContinue(notice); expect(submit).not.toHaveBeenCalled();
    await render({ canWrite: true }); expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).not.toBeNull();
    await render({ conversationId: "other-chat", messages: [] }); await controls!.onContinue(notice); expect(submit).not.toHaveBeenCalled();
  });
  it("does not offer Continue for legacy notices or a persisted continuation", async () => {
    await render(); expect(controls!.canContinue({ ...notice, metadata: null })).toBe(false);
    await render({ messages: [asked, notice, {
      id: "follow-up", role: "user", authorId: "viewer", content: WARRANTY, timestamp: 2, files: null,
      metadata: { runId: "run-3", prompt_metadata: { continuedStopMessageId: notice.id, continuedRunIds: ["run-1"] } },
    }] });
    expect(controls!.canContinue(notice)).toBe(false);
    // Nor for a request the chat does not show: it would carry on nothing.
    await render({ messages: [notice] });
    expect(controls!.canContinue(notice)).toBe(false);
  });
  // A local test, Nov 3: the person undid the stopped turn's edit, and the row still
  // offered Continue, which would put the undone change back.
  it("does not offer Continue once the person undid what the stopped turn changed", async () => {
    const undone: ChatMessage = {
      id: "undo-line", role: "assistant", authorId: null, timestamp: 2, files: null,
      content: "The person undid the change from “Add a section.”",
      metadata: { source: "controller", kind: "change_undone", presentation: { hidden: true },
        undoneMessageId: "files-1", undoneRunId: "run-2" },
    };
    await render({ messages: [asked, notice, undone] });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).toBeNull();
    // Another run's Undo leaves this one's Continue, and so does a message
    // that only calls itself an Undo's line (no controller source).
    await render({ messages: [asked, notice, { ...undone, metadata: { ...undone.metadata, undoneRunId: "run-9" } }] });
    expect(controls!.canContinue(notice)).toBe(true);
    await render({ messages: [asked, notice, { ...undone, metadata: { ...undone.metadata, source: "client" } }] });
    expect(controls!.canContinue(notice)).toBe(true);
  });
  // A local test, Nov 4: the row of a turn stopped before it changed anything
  // still offered Continue after two later turns had finished, and again
  // after a reload.
  it("offers Continue only on the chat's latest turn", async () => {
    const askedAt = (id: string, timestamp: number, runId?: string): ChatMessage => ({
      id, role: "user", authorId: "viewer", content: "Add a one-line tip.", timestamp, files: null,
      ...(runId ? { metadata: { runId } } : {}),
    });
    const replied = (id: string, timestamp: number, jobId: string): ChatMessage => ({
      id, role: "assistant", authorId: null, content: "Added the tip.", timestamp, files: null,
      metadata: { jobId },
    });
    const continueButton = () => container.querySelector('[data-testid="chat-run-stop-continue"]');
    // The stopped turn's own late rows and the lines nobody wrote keep it
    // the latest.
    const ownLateRow = replied("late", 2, "job-2");
    const hiddenLine: ChatMessage = {
      id: "hidden", role: "assistant", authorId: null, content: "The person undid the change from “…”", timestamp: 3,
      files: null, metadata: { source: "controller", kind: "change_undone", presentation: { hidden: true },
        undoneMessageId: "other", undoneRunId: "run-9" },
    };
    await render({ messages: [asked, notice, ownLateRow, hiddenLine] });
    expect(controls!.canContinue(notice)).toBe(true);
    expect(continueButton()).not.toBeNull();

    // Then the person asked for something else, and that turn finished.
    const later = [asked, notice, ownLateRow, hiddenLine, askedAt("next", 4), replied("next-reply", 5, "job-3")];
    await render({ messages: later });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(continueButton()).toBeNull();
    // After a reload the chat holds the same messages: still no Continue.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ messages: [...later] });
    expect(continueButton()).toBeNull();
    // A later stopped turn is the latest one: its row offers Continue.
    const laterStop: ChatMessage = { ...notice, id: "stop-2", timestamp: 6, metadata: { details: {
      stopRequested: true, actorUserId: "viewer", agentHandles: ["octo"], jobIds: ["job-4"], runIds: ["run-4"],
    } } };
    await render({ messages: [...later, askedAt("again", 6, "run-4"), laterStop] });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(controls!.canContinue(laterStop)).toBe(true);

    // Opened at a message the person searched for, the chat shows the
    // messages around it: with newer ones not shown, nobody can tell that
    // the stop is still the latest, so it offers no Continue until they are.
    await render({ messages: [asked, notice, ownLateRow, hiddenLine], hasNewer: true });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(continueButton()).toBeNull();
    await render({ hasNewer: false });
    expect(controls!.canContinue(notice)).toBe(true);
  });
  describe("a message Octo answers in its browser and then builds from", () => {
    // The person's message, the routing step's card, the browser turn that
    // carried it on and read the pages, and the hand-back of what it found.
    const card: ChatMessage = {
      id: "card", role: "assistant", authorId: null, content: "Continue this task in Instafy's browser.", timestamp: 1,
      files: null, messageType: "action_request", metadata: {
        jobId: "job-card", runId: "run-1", messageType: "action_request",
        details: { browserRequest: { task: WARRANTY, routed: true, location: "auto", continueBuilding: true } },
      },
    };
    const browserTurn: ChatMessage = {
      id: "browser-turn", role: "user", authorId: "viewer", content: "Octo opened Instafy's browser", timestamp: 2,
      files: null, metadata: { runId: "run-2", prompt_metadata: {
        browserRequestOf: "job:job-card", browserAutoStarted: true, displayContent: "Octo opened Instafy's browser",
      } },
    };
    const browserStep: ChatMessage = {
      id: "browser-step", role: "assistant", authorId: null, content: "Tool call completed: instafy_shared_browser/navigate",
      timestamp: 3, files: null, metadata: { jobId: "job-browser", runId: "run-2", messageType: "mcp_tool_call" },
    };
    // Its stored copy keeps the controller's record, with when the browser
    // turn ended (`readAt`), which the controller counts the half hour from.
    const handBackEnded = (minutesAgo: number): ChatMessage => ({
      id: "hand-back", role: "user", authorId: "viewer", content: "Octo continued with what it found in the browser",
      timestamp: 4, files: null, metadata: {
        runId: "run-3",
        browserHandBack: {
          browserJobId: "job-browser", cardJobId: "job-card", version: 1,
          readAt: new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
        },
      },
    });
    const handBack = handBackEnded(1);
    const stopOf = (runId: string, jobId: string, timestamp: number): ChatMessage => ({
      id: `stop-${runId}`, role: "assistant", authorId: null, content: "Stopped this run.", timestamp, files: null,
      messageType: "run_cancellation", metadata: { source: "controller", kind: "run_cancellation", runId, details: {
        stopRequested: true, actorUserId: "viewer", agentHandles: ["octo"], jobIds: [jobId], runIds: [runId],
      } },
    });
    const asked0: ChatMessage = { ...asked, metadata: { runId: "run-1" } };
    const resendHandBack = vi.fn<(handBack: ChatMessage, metadata: Record<string, unknown>) => Promise<boolean>>();
    beforeEach(() => {
      resendHandBack.mockReset();
    });

    // A local test, Nov 8: the person pressed Stop in the gap between the browser
    // turn and its build. Continue went through the routing step again, its
    // browser turn had nothing new to open and failed, and it took a Try again.
    it("starts the build again after a Stop in the gap, with no routing step and no browser turn", async () => {
      const gapStop = stopOf("run-3", "job-build", Date.now());
      resendHandBack.mockResolvedValue(true);
      await render({ messages: [asked0, card, browserTurn, browserStep, handBack, gapStop], resendHandBack });
      expect(controls!.canContinue(gapStop)).toBe(true);
      await act(async () => { await controls!.onContinue(gapStop); await controls!.onContinue(gapStop); });
      expect(resendHandBack).toHaveBeenCalledTimes(1);
      expect(resendHandBack).toHaveBeenCalledWith(handBack, { continuedStopMessageId: gapStop.id, continuedRunIds: ["run-3"] });
      expect(submit).not.toHaveBeenCalled();
    });

    // The controller would not start that build again (its lane was busy, or
    // another page started it already): nothing else is sent, never the
    // request a second time, and the row keeps Continue. The send left its
    // own copy in the chat, as every send does, which never went out: it
    // took nothing on from the Stop.
    it("sends nothing else when the build can't start again, and keeps Continue", async () => {
      forgetPromptsSentFromThisPageForTests();
      const gapStop = stopOf("run-3", "job-build", Date.now());
      const messages = [asked0, card, browserTurn, browserStep, handBack, gapStop];
      resendHandBack.mockImplementation(async (prompt, metadata) => {
        const resent = browserHandBackRetry(prompt, metadata)!;
        const copy = createConversationMessage("user", resent.extras.display, "viewer", {
          ...resent.extras.metadata, clientMessageId: "continue-copy",
        });
        rememberPromptSentFromThisPage(copy);
        recordSendFailedForPromptSentFromThisPage(copy);
        messages.push(copy);
        await render({ messages: [...messages] });
        return false;
      });
      await render({ messages: [...messages], resendHandBack });
      let sent: boolean | undefined;
      await act(async () => { sent = await controls!.onContinue(gapStop); });
      expect(sent).toBe(false);
      expect(resendHandBack).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(controls!.canContinue(gapStop)).toBe(true);
      forgetPromptsSentFromThisPageForTests();
    });

    // The controller hands a browser turn's findings back for half an hour
    // after that turn ended, not after the Stop: later, the request runs again.
    it("runs the request again once its browser turn is too old to build from", async () => {
      const gapStop = stopOf("run-3", "job-build", Date.now() - 31 * 60_000);
      submit.mockResolvedValue(true);
      await render({ messages: [asked0, card, browserTurn, browserStep, handBackEnded(31), gapStop], resendHandBack });
      await act(async () => { await controls!.onContinue(gapStop); });
      expect(resendHandBack).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ message: WARRANTY }), expect.anything());

      // A Stop late in a long build: its browser turn ended over half an
      // hour ago, though the Stop came only 22 minutes ago.
      submit.mockClear();
      const buildStop = { ...stopOf("run-3", "job-build", Date.now() - 22 * 60_000), id: "stop-late-in-the-build" };
      await render({ messages: [asked0, card, browserTurn, browserStep, handBackEnded(32), buildStop] });
      await act(async () => { await controls!.onContinue(buildStop); });
      expect(resendHandBack).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ message: WARRANTY }), expect.anything());
    });

    // After a reload the chat holds only its newest messages: a long browser
    // turn's opening, its card and the person's message may be older.
    // Starting the build again needs only the hand-back, which is the
    // person's own (the controller checks that too).
    it("starts the build again when the chat shows only the build's last messages", async () => {
      const gapStop = stopOf("run-3", "job-build", Date.now());
      resendHandBack.mockResolvedValue(true);
      await render({ messages: [browserStep, handBack, gapStop], resendHandBack });
      expect(controls!.canContinue(gapStop)).toBe(true);
      await act(async () => { await controls!.onContinue(gapStop); });
      expect(resendHandBack).toHaveBeenCalledWith(handBack, { continuedStopMessageId: gapStop.id, continuedRunIds: ["run-3"] });
      // Someone else's hand-back is not theirs to start again.
      await render({ messages: [browserStep, { ...handBack, authorId: "teammate" }, gapStop] });
      expect(controls!.canContinue(gapStop)).toBe(false);
    });

    // Continue sends the request again, every turn of it: an Undo of any of
    // them (here the turn that posted the browser card) is the person taking
    // it back, as the runtime reads it (`stopped_requests`).
    it("does not carry the request on once the person undid a change of any of its turns", async () => {
      const ownCard: ChatMessage = {
        ...card, metadata: { ...card.metadata, details: { browserRequest: { task: "Read each warranty page.", location: "auto", continueBuilding: true } } },
      };
      const undoneRun1: ChatMessage = {
        id: "undo-run-1", role: "assistant", authorId: null, timestamp: 9, files: null,
        content: `The person undid the change from “${WARRANTY}”`,
        metadata: { source: "controller", kind: "change_undone", presentation: { hidden: true },
          undoneMessageId: "files-1", undoneRunId: "run-1" },
      };
      const browserStop = stopOf("run-2", "job-browser", Date.now());
      submit.mockResolvedValue(true);
      resendHandBack.mockResolvedValue(true);
      await render({ messages: [asked0, ownCard, browserTurn, browserStep, browserStop, undoneRun1], resendHandBack });
      expect(controls!.canContinue(browserStop)).toBe(false);
      await act(async () => { await controls!.onContinue(browserStop); });
      const gapStop = stopOf("run-3", "job-build", Date.now());
      await render({ messages: [asked0, ownCard, browserTurn, browserStep, handBack, gapStop, undoneRun1] });
      expect(controls!.canContinue(gapStop)).toBe(false);
      await act(async () => { await controls!.onContinue(gapStop); });
      expect(submit).not.toHaveBeenCalled();
      expect(resendHandBack).not.toHaveBeenCalled();
    });

    // A Stop while the browser turn read: the request runs again under the
    // person's own words, never the browser turn's line or Studio's words.
    it("runs the request again under its own words after a Stop in the browser turn", async () => {
      const browserStop = stopOf("run-2", "job-browser", Date.now());
      submit.mockResolvedValue(true);
      await render({ messages: [asked0, card, browserTurn, browserStep, browserStop], resendHandBack });
      await act(async () => { await controls!.onContinue(browserStop); });
      expect(resendHandBack).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith({
        message: WARRANTY,
        editorState: null,
        targetAgentHandles: ["octo"],
        metadata: { continuedStopMessageId: browserStop.id, continuedRunIds: ["run-2"] },
      }, expect.objectContaining({ automatic: true, intent: "send" }));
    });
  });

  // Continue sends the stopped request's words in the person's name, so only
  // words they wrote: never the line Studio wrote for a site's Ask Octo from
  // the page's own words (the page chose them, and its turn reads them as
  // page data only with `siteIntent`), nor an answer the controller wrote.
  it("never sends words the person didn't write as their request", async () => {
    const siteAsk: ChatMessage = {
      ...asked, content: "Is size 10 in stock for Karhu ikoni 3? · via Running shoes",
      metadata: { runId: "run-1", prompt_metadata: { siteIntent: {
        previewId: "preview-1", askId: "ask-1", intent: "check_stock", label: "Check stock", ref: "karhu-ikoni-3",
        params: { size: "10" }, verified: true,
      } } },
    };
    const answer: ChatMessage = {
      ...asked, content: "City: Porto", metadata: { runId: "run-1", userInputRequestId: "question-1" },
    };
    for (const request of [siteAsk, answer]) {
      await render({ messages: [request, notice] });
      expect(controls!.canContinue(notice)).toBe(false);
      expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).toBeNull();
      await act(async () => { await controls!.onContinue(notice); });
    }
    expect(submit).not.toHaveBeenCalled();
  });

  // A teammate's message that names the viewer's earlier run as one it
  // carries on: its Stop is no turn of the viewer's request, so Continue
  // would bring back an older request of theirs nobody stopped here.
  it("carries on only a turn the viewer sent", async () => {
    const theirs: ChatMessage = {
      id: "theirs", role: "user", authorId: "teammate", content: "Make the table wider.", timestamp: 2, files: null,
      metadata: { runId: "run-5", prompt_metadata: { continuedStopMessageId: "stop-0", continuedRunIds: ["run-1"] } },
    };
    const theirStop: ChatMessage = { ...notice, id: "stop-5", timestamp: 3, metadata: { details: {
      stopRequested: true, actorUserId: "viewer", agentHandles: ["octo"], jobIds: ["job-5"], runIds: ["run-5"],
    } } };
    await render({ messages: [asked, theirs, theirStop] });
    expect(controls!.canContinue(theirStop)).toBe(false);
    await act(async () => { await controls!.onContinue(theirStop); });
    expect(submit).not.toHaveBeenCalled();
  });

  it("allows retry after failed submission but considers queued continuation accepted", async () => {
    submit.mockResolvedValueOnce(false).mockImplementationOnce(async (_override, options) => { options?.onQueued?.(); return false; });
    await render(); expect(await controls!.onContinue(notice)).toBe(false);
    expect(controls!.canContinue(notice)).toBe(true);
    expect(await controls!.onContinue(notice)).toBe(true);
    expect(controls!.canContinue(notice)).toBe(false);
  });
});
