// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";
import type { ControllerEventPayload } from "../../services/runtimeController/runs";
import {
  applyReplyDraft,
  applyReplyDraftEvent,
  conversationReplyDrafts,
  parseReplyDraftEvent,
  REPLY_DRAFT_RUN_ENDED_GRACE_MS,
  replyDraftChatMessage,
  resetReplyDraftsForTests,
  selectVisibleReplyDrafts,
  useReplyDraftMessages,
  type ReplyDraft,
} from "../replyDrafts";

function draftEvent(
  data: Record<string, unknown>,
  overrides: Partial<ControllerEventPayload> = {},
): ControllerEventPayload {
  return {
    kind: "run.reply_draft",
    project_id: "project-1",
    conversation_id: "conversation-1",
    run_id: "run-1",
    job_id: "job-1",
    data: { jobId: "job-1", runId: "run-1", conversationId: "conversation-1", segment: 1, seq: 1, text: "Hel", ...data },
    ...overrides,
  };
}

function draft(overrides: Partial<ReplyDraft> = {}): ReplyDraft {
  return {
    conversationId: "conversation-1",
    jobId: "job-1",
    runId: "run-1",
    segment: 1,
    seq: 1,
    text: "Hello there",
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: "m", role: "assistant", content: "", timestamp: 0, messageType: null, metadata: null, ...overrides };
}

const reply = message({
  id: "reply",
  content: "Hello there",
  timestamp: 1_000,
  metadata: { source: "agent", jobId: "job-1", runId: "run-1" },
});

describe("reply drafts", () => {
  afterEach(() => resetReplyDraftsForTests());

  it("reads a draft event and refuses a malformed one", () => {
    expect(parseReplyDraftEvent(draftEvent({}), 5)).toEqual({
      conversationId: "conversation-1",
      jobId: "job-1",
      runId: "run-1",
      segment: 1,
      seq: 1,
      text: "Hel",
      startedAt: 5,
      updatedAt: 5,
    });
    expect(parseReplyDraftEvent(draftEvent({ seq: "2" }))).toBeNull();
    expect(parseReplyDraftEvent(draftEvent({ text: null }))).toBeNull();
    expect(parseReplyDraftEvent(draftEvent({ jobId: null }, { job_id: null }))).toBeNull();
    expect(parseReplyDraftEvent({ ...draftEvent({}), kind: "run.progress" })).toBeNull();
  });

  it("keeps the newest draft of a job, in its place until the text starts over", () => {
    const latest = () => conversationReplyDrafts("conversation-1")[0];
    applyReplyDraft(draft({ seq: 2, text: "Hello", startedAt: 100, updatedAt: 100 }));
    // A draft sent before the latest arrives late and changes nothing.
    applyReplyDraft(draft({ seq: 1, text: "Hel", startedAt: 90, updatedAt: 90 }));
    expect(latest()).toMatchObject({ seq: 2, text: "Hello", startedAt: 100 });

    applyReplyDraft(draft({ seq: 3, text: "Hello there", startedAt: 300, updatedAt: 300 }));
    expect(latest()).toMatchObject({ seq: 3, text: "Hello there", startedAt: 100, updatedAt: 300 });

    // Another attempt's text replaces it, placed where that attempt began.
    applyReplyDraft(draft({ seq: 4, segment: 2, text: "Sorry,", startedAt: 500, updatedAt: 500 }));
    expect(latest()).toMatchObject({ segment: 2, text: "Sorry,", startedAt: 500 });

    expect(conversationReplyDrafts("conversation-2")).toHaveLength(0);
  });

  it("gives way to the message that replaces it, and to nothing else", () => {
    const active = new Set(["run-1"]);
    const visible = (messages: ChatMessage[]) => selectVisibleReplyDrafts([draft()], messages, active, 2_000);

    expect(visible([])).toHaveLength(1);
    // The run's progress and usage rows are not its reply, nor is the draft's own row.
    expect(
      visible([
        message({ id: "status", messageType: "status", metadata: { messageType: "status", jobId: "job-1" } }),
        message({ id: "usage", messageType: "token_usage", metadata: { messageType: "token_usage", jobId: "job-1" } }),
        replyDraftChatMessage(draft()),
      ]),
    ).toHaveLength(1);
    // Another job's reply is not this one's either.
    expect(visible([message({ id: "other", metadata: { jobId: "job-2", runId: "run-2" } })])).toHaveLength(1);

    expect(visible([reply])).toHaveLength(0);
    // A failed run's error replaces it too, and a job thread shows the turn itself.
    expect(
      visible([message({ id: "error", messageType: "error", metadata: { messageType: "error", jobId: "job-1" } })]),
    ).toHaveLength(0);
    expect(
      visible([
        message({
          id: "agent-job-thread:job-1",
          messageType: "agent_job_thread",
          metadata: { messageType: "agent_job_thread", jobId: "job-1" },
        }),
      ]),
    ).toHaveLength(0);
  });

  it("shows no empty draft, and lets go of one whose run ended without a reply", () => {
    expect(selectVisibleReplyDrafts([draft({ text: "  " })], [], new Set(["run-1"]), 2_000)).toHaveLength(0);
    const ended = new Set<string>();
    expect(selectVisibleReplyDrafts([draft()], [], ended, 1_000 + REPLY_DRAFT_RUN_ENDED_GRACE_MS - 1)).toHaveLength(1);
    expect(selectVisibleReplyDrafts([draft()], [], ended, 1_000 + REPLY_DRAFT_RUN_ENDED_GRACE_MS)).toHaveLength(0);
  });

  it("stands in the transcript as an assistant message of its job and run", () => {
    expect(replyDraftChatMessage(draft())).toEqual({
      id: "reply-draft:job-1",
      role: "assistant",
      content: "Hello there",
      timestamp: 1_000,
      messageType: null,
      metadata: { source: "agent", replyDraft: true, jobId: "job-1", runId: "run-1" },
    });
  });
});

describe("useReplyDraftMessages", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rendered: Array<{ messages: ChatMessage[]; draftingRunActive: boolean }>;
  const activeRuns = new Set(["run-1"]);

  function Transcript({ messages, activeRunIds }: { messages: ChatMessage[]; activeRunIds: ReadonlySet<string> }) {
    rendered.push(useReplyDraftMessages("conversation-1", messages, activeRunIds));
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rendered = [];
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetReplyDraftsForTests();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("grows the draft and swaps it for the reply in the render that adds the reply", async () => {
    const user = message({ id: "ask", role: "user", content: "Say hello", timestamp: 500 });
    await act(async () => root.render(<Transcript messages={[user]} activeRunIds={activeRuns} />));
    expect(rendered.at(-1)).toEqual({ messages: [], draftingRunActive: false });

    await act(async () => applyReplyDraftEvent(draftEvent({ seq: 1, text: "Hel" })));
    await act(async () => applyReplyDraftEvent(draftEvent({ seq: 2, text: "Hello there" })));
    const growing = rendered.at(-1)!;
    expect(growing.messages.map((entry) => entry.content)).toEqual(["Hello there"]);
    expect(growing.draftingRunActive).toBe(true);

    rendered = [];
    await act(async () => root.render(<Transcript messages={[user, reply]} activeRunIds={activeRuns} />));
    // No render shows both the draft and the reply, or neither.
    expect(rendered.length).toBeGreaterThan(0);
    for (const frame of rendered) expect(frame.messages).toEqual([]);
    // The run is still finishing: its typing row stays away under the reply.
    expect(rendered.at(-1)!.draftingRunActive).toBe(true);

    // A late draft of the same job does not bring the text back.
    await act(async () => applyReplyDraftEvent(draftEvent({ seq: 3, text: "Hello there!" })));
    expect(rendered.at(-1)!.messages).toEqual([]);

    await act(async () => root.render(<Transcript messages={[user, reply]} activeRunIds={new Set()} />));
    expect(rendered.at(-1)).toEqual({ messages: [], draftingRunActive: false });
  });

  it("does not bring a finished run's draft back when the transcript changes later", async () => {
    const user = message({ id: "ask", role: "user", content: "Say hello", timestamp: 500 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(10_000);
      await act(async () => root.render(<Transcript messages={[user]} activeRunIds={activeRuns} />));
      vi.setSystemTime(20_000);
      await act(async () => applyReplyDraftEvent(draftEvent({ seq: 1, text: "Hello there" })));
      await act(async () => root.render(<Transcript messages={[user, reply]} activeRunIds={new Set()} />));
      expect(rendered.at(-1)!.messages).toEqual([]);

      // A minute on, a jump to older history leaves the reply out of the transcript.
      vi.setSystemTime(80_000);
      await act(async () => root.render(<Transcript messages={[user]} activeRunIds={new Set()} />));
      expect(rendered.at(-1)).toEqual({ messages: [], draftingRunActive: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
