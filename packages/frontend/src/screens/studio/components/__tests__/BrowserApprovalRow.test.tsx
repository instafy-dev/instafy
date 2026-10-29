// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSharedBrowserApprovalRequest } from "../../../../sdk/instafy";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout } from "../AgentJobThreadPreviewLayout";
import {
  BROWSER_APPROVAL_GONE_GRACE_MS,
  BROWSER_APPROVAL_ROW_COPY,
  BrowserApprovalRow,
  browserApprovalSentence,
} from "../BrowserApprovalRow";
import { ChatBubbleRow } from "../ChatBubbleRow";
import type { SessionBrowserApproval } from "../turnActivity";
import { ACTIVITY_LABEL_HOLD_MS } from "../useSteadyActivityLabel";
import {
  BROWSER_APPROVAL_UNCLAIMED_FALLBACK_MS,
  fallbackRowContinuesTail,
  TurnBrowserApprovalContext,
  TurnBrowserApprovalStateContext,
  useTurnBrowserApprovalProvider,
} from "../turnBrowserApproval";
import { useAgentJobThreadPreviewState } from "../useAgentJobThreadPreviewState";
import type { SharedBrowserApprovalState } from "../useSharedBrowserApproval";

const NOW = Date.UTC(2026, 9, 27, 9, 12, 0);
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const CONTROLLER_ID = "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5";
const live = vi.hoisted(() => ({ inFlight: true }));

function run(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: RUN_ID, projectId: "project-1", sessionId: null, conversationId: CONTROLLER_ID, promptId: null,
    runType: "prompt", status: live.inFlight ? "in_progress" : "success", progress: 0, progressStage: null,
    previewUrl: null, lastMessage: null, metadata: { jobId: RUN_ID }, createdAt: now, updatedAt: now,
  };
}

vi.mock("../../../../conversations/ConversationsProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../conversations/ConversationsProvider")>()),
  useConversations: () => ({
    activeConversation: {
      localId: "conversation-local", controllerId: CONTROLLER_ID,
      pendingRunIds: live.inFlight ? [RUN_ID] : [], awaitingLeaseRunIds: [], pendingRunSubmittedAt: {}, messages: [],
    },
    conversations: [],
  }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runs: { [RUN_ID]: run() } }),
}));

function request(overrides: Partial<RuntimeSharedBrowserApprovalRequest> = {}): RuntimeSharedBrowserApprovalRequest {
  return {
    version: 1, approvalId: "22222222-2222-4222-8222-222222222222", kind: "action",
    ownerId: "33333333-3333-4333-8333-333333333333", runId: RUN_ID,
    initiatorUserId: "55555555-5555-4555-8555-555555555555", browserPageId: "page-of-the-job",
    operation: "form-submit", sourceOrigin: "https://www.visitlisboa.com", destinationOrigin: "https://www.visitlisboa.com",
    destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
    requestedAtMs: NOW, expiresAtMs: NOW + 120_000, requestFingerprint: "e".repeat(64),
    display: { label: "Search", destinationOrigin: null },
    ...overrides,
  };
}

function approval(overrides: Partial<SharedBrowserApprovalState> = {}): SharedBrowserApprovalState {
  return {
    pending: null, submitting: false, error: null, routineApprovedRunId: null, lastDecision: null,
    decide: vi.fn(async () => {}), ...overrides,
  };
}

const withPending = (value: RuntimeSharedBrowserApprovalRequest, overrides: Partial<SharedBrowserApprovalState> = {}) =>
  approval({ pending: { runtimeId: "11111111-1111-4111-8111-111111111111", request: value }, ...overrides });

const isDisabled = (element: HTMLElement | null) =>
  Boolean(element?.hasAttribute("disabled") || element?.getAttribute("aria-disabled") === "true");

/** Presses Allow in the commit that hands the row a new prompt, before the row's effects show it. */
type Seen = { current: { text: string; disabled: boolean } | null };
function PressDuringCommit({ container, seen }: { container: HTMLElement; seen: Seen | null }) {
  useLayoutEffect(() => {
    if (!seen || seen.current) return;
    const allow = container.querySelector<HTMLElement>("[data-testid='browser-approval-allow']");
    seen.current = {
      text: container.querySelector("[data-testid='browser-approval-row']")?.textContent ?? "",
      disabled: isDisabled(allow),
    };
    allow?.click();
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  live.inFlight = true;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
const text = () => container.textContent ?? "";

describe("BrowserApprovalRow", () => {
  const settled: SessionBrowserApproval[] = [];
  async function render(state: SharedBrowserApprovalState) {
    await act(async () => {
      root.render(<BrowserApprovalRow agentDisplayName="Octo" approval={state} onSettled={(entry) => settled.push(entry)} />);
    });
  }
  beforeEach(() => { settled.length = 0; });

  it("asks in one row: a lock, one sentence, Deny then Allow, and never takes focus", async () => {
    await render(withPending(request()));
    const row = byTestId("browser-approval-row")!;
    expect(row.getAttribute("role")).toBe("group");
    const sentence = byTestId("browser-approval-sentence")!;
    expect(row.getAttribute("aria-labelledby")).toBe(sentence.id);
    expect(sentence.textContent).toBe("Octo wants to send the form “Search” on visitlisboa.com.");
    const buttons = [...row.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Deny", "Allow"]);
    expect(document.activeElement).toBe(document.body);
    // No card, overline or "Only you can answer" any more.
    expect(text()).not.toContain("Instafy's browser");
    expect(text()).not.toContain("Only you can answer");
  });

  it.each([
    [{ kind: "origin", operation: "approve-origin", sourceOrigin: null, display: { label: "", destinationOrigin: "https://www.carris.pt" } },
      "Octo wants to use carris.pt.", "Allow site"],
    [{ kind: "origin", operation: "approve-origin", display: { label: "Octo's tab 1: Open https://www.visitlisboa.com/en/places/belem-tower in a new tab", destinationOrigin: "https://www.visitlisboa.com" } },
      "Octo wants to open www.visitlisboa.com/en/places/belem-tower.", "Allow site"],
    // The step's category is a sentence of its own, never part of the quoted name.
    [{ operation: "navigate", display: { label: "Download or export: Go to https://www.visitlisboa.com/files/guide.pdf", destinationOrigin: "https://www.visitlisboa.com" } },
      "Octo wants to open www.visitlisboa.com/files/guide.pdf. It may download or export data.", "Allow"],
    [{ operation: "click", display: { label: "Change something: unnamed button in the top right", destinationOrigin: null } },
      "Octo wants to click “unnamed button in the top right” on visitlisboa.com.", "Allow"],
    [{ operation: "click", display: { label: "Delete, cancel or sign out: Delete account", destinationOrigin: null } },
      "Octo wants to click “Delete account” on visitlisboa.com. It may delete, cancel or sign out of something.", "Allow"],
    [{ operation: "click", display: { label: "Octo's tab 1: Pesquisa", destinationOrigin: null } },
      "Octo wants to click “Octo's tab 1: Pesquisa” on visitlisboa.com.", "Allow"],
    [{ operation: "type", display: { label: "Your email", destinationOrigin: null } },
      "Octo wants to type into “Your email” on visitlisboa.com.", "Allow"],
    [{ operation: "form-submit", destinationOrigin: "https://search.example.org", display: { label: "Search", destinationOrigin: "https://search.example.org" } },
      "Octo wants to send the form “Search” on visitlisboa.com. It goes to search.example.org.", "Allow"],
    [{ operation: "form-submit", display: { label: "", destinationOrigin: null } },
      "Octo wants to send a form on visitlisboa.com.", "Allow"],
    [{ operation: "press-enter", display: { label: "Places", destinationOrigin: null } },
      "Octo wants to press Enter on “Places” on visitlisboa.com.", "Allow"],
    [{ operation: "press-key", display: { label: "Press Tab on Places", destinationOrigin: null } },
      "Octo wants to press Tab on Places on visitlisboa.com.", "Allow"],
  ] as const)("says what it waits for in one sentence (%#)", async (overrides, sentence, allow) => {
    const value = request(overrides as Partial<RuntimeSharedBrowserApprovalRequest>);
    expect(browserApprovalSentence("Octo", value)).toBe(sentence);
    await render(withPending(value));
    expect(byTestId("browser-approval-allow")?.textContent).toBe(allow);
  });

  it("shows no countdown until the last minute", async () => {
    await render(withPending(request()));
    expect(byTestId("browser-approval-expiry")).toBeNull();
    expect(text()).not.toMatch(/\d:\d\d/u);
    await advance(59_000);
    expect(byTestId("browser-approval-expiry")).toBeNull();
    await advance(2_000);
    const expiry = byTestId("browser-approval-expiry")!;
    expect(expiry.textContent).toBe("Expires in under a minute");
    expect(expiry.getAttribute("role")).toBe("timer");
    expect(expiry.getAttribute("aria-live")).toBe("off");
  });

  it("announces itself once, politely", async () => {
    await render(withPending(request()));
    const announcement = byTestId("browser-approval-announcement")!;
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(announcement.textContent).toBe("Octo needs your answer: Octo wants to send the form “Search” on visitlisboa.com.");
    await advance(5_000);
    await render(withPending({ ...request() }));
    expect(allByTestId("browser-approval-announcement")).toHaveLength(1);
  });

  it("answers with the same decisions as the sheet", async () => {
    const actionState = withPending(request());
    await render(actionState);
    await act(async () => { byTestId("browser-approval-allow")!.click(); });
    expect(actionState.decide).toHaveBeenCalledWith("allow_once", "22222222-2222-4222-8222-222222222222");
    await act(async () => { byTestId("browser-approval-deny")!.click(); });
    expect(actionState.decide).toHaveBeenCalledWith("deny", "22222222-2222-4222-8222-222222222222");

    const originState = withPending(request({
      approvalId: "77777777-7777-4777-8777-777777777777", kind: "origin", operation: "approve-origin",
      sourceOrigin: null, destinationOrigin: "https://example.test",
    }));
    await render(originState);
    expect(byTestId("browser-approval-allow")?.textContent).toBe(BROWSER_APPROVAL_ROW_COPY.allowSite);
    await act(async () => { byTestId("browser-approval-allow")!.click(); });
    expect(originState.decide).toHaveBeenCalledWith("allow_origin", "77777777-7777-4777-8777-777777777777");
  });

  it("never answers a newer prompt with the buttons of the one on screen", async () => {
    const shown = request();
    const newer = request({ approvalId: "99999999-9999-4999-8999-999999999999", display: { label: "Rechnung löschen", destinationOrigin: null } });
    const renderWithPress = (state: SharedBrowserApprovalState, seen: Seen | null) => act(async () => {
      root.render(<>
        <BrowserApprovalRow agentDisplayName="Octo" approval={state} />
        <PressDuringCommit container={container} seen={seen} />
      </>);
    });
    await renderWithPress(withPending(shown), null);
    const newerState = withPending(newer);
    const seen: Seen = { current: null };
    await renderWithPress(newerState, seen);
    expect(seen.current?.text).toContain("“Search”");
    expect(seen.current?.text).not.toContain("Rechnung löschen");
    expect(seen.current?.disabled).toBe(true);
    expect(newerState.decide).not.toHaveBeenCalled();
    expect(text()).toContain("Rechnung löschen");
    await act(async () => { byTestId("browser-approval-allow")!.click(); });
    expect(newerState.decide).toHaveBeenCalledExactlyOnceWith("allow_once", newer.approvalId);
  });

  it("keeps a prompt that went away over a gap between polls, without live buttons", async () => {
    const value = request();
    await render(withPending(value));
    const gone = approval();
    await render(gone);
    expect(isDisabled(byTestId("browser-approval-allow"))).toBe(true);
    expect(isDisabled(byTestId("browser-approval-deny"))).toBe(true);
    await act(async () => { byTestId("browser-approval-allow")!.click(); });
    expect(gone.decide).not.toHaveBeenCalled();
    await advance(BROWSER_APPROVAL_GONE_GRACE_MS - 500);
    await render(withPending({ ...value }));
    await advance(BROWSER_APPROVAL_GONE_GRACE_MS);
    expect(byTestId("browser-approval-row")).not.toBeNull();
    // Answered on another device, or the run stopped: it goes, and nothing is reported.
    await render(approval());
    await advance(BROWSER_APPROVAL_GONE_GRACE_MS);
    expect(byTestId("browser-approval-row")).toBeNull();
    expect(settled).toEqual([]);
  });

  it("holds its buttons while an answer is saved, and shows what went wrong after them", async () => {
    await render(withPending(request(), { submitting: true, error: "Could not save the approval. Check your connection and try again." }));
    expect(isDisabled(byTestId("browser-approval-allow"))).toBe(true);
    expect(isDisabled(byTestId("browser-approval-deny"))).toBe(true);
    const error = byTestId("browser-approval-error")!;
    expect(error.getAttribute("role")).toBe("alert");
    const row = byTestId("browser-approval-row")!;
    const order = [...row.querySelectorAll("[data-testid]")].map((element) => element.getAttribute("data-testid"));
    expect(order.indexOf("browser-approval-error")).toBeGreaterThan(order.indexOf("browser-approval-allow"));
  });

  it.each([
    ["allow_once", "allowed"],
    ["deny", "denied"],
  ] as const)("goes once answered (%s), whichever surface answered, and says what was decided", async (decision, outcome) => {
    const value = request();
    await render(withPending(value));
    await render(approval({ lastDecision: { approvalId: value.approvalId, decision } }));
    expect(byTestId("browser-approval-row")).toBeNull();
    expect(byTestId("chat-browser-approval-state")).toBeNull();
    expect(container.innerHTML).toBe("");
    expect(settled).toEqual([{
      approvalId: value.approvalId, outcome, operation: "form-submit",
      host: "visitlisboa.com", destinationHost: "visitlisboa.com",
    }]);
  });

  it("goes when nobody answered in time, and says it expired", async () => {
    await render(withPending(request()));
    await advance(120_000);
    expect(byTestId("browser-approval-row")).toBeNull();
    expect(settled.map((entry) => entry.outcome)).toEqual(["expired"]);
    await render(approval());
    await advance(BROWSER_APPROVAL_GONE_GRACE_MS * 2);
    expect(container.innerHTML).toBe("");
  });

  it("asks again for a new prompt after an answer", async () => {
    const first = request();
    await render(withPending(first));
    await render(approval({ lastDecision: { approvalId: first.approvalId, decision: "allow_once" } }));
    await render(withPending(request({ approvalId: "88888888-8888-4888-8888-888888888888", operation: "navigate",
      destinationOrigin: "https://example.test", display: { label: "", destinationOrigin: "https://example.test" } })));
    expect(text()).toContain("Octo wants to open example.test.");
    expect(byTestId("browser-approval-allow")).not.toBeNull();
  });

  it("shows nothing without a prompt", async () => {
    await render(approval());
    expect(container.innerHTML).toBe("");
  });
});

// The turn: the prompt shows inside Octo's turn, under its activity line, and
// collapses into the turn's line once answered.

function MessageContent({ content }: { content: string }) {
  return <div data-testid="message-content">{content}</div>;
}

function Turn({ threadMessages }: { threadMessages: ChatMessage[] }) {
  const message: ChatMessage = {
    id: `agent-job-thread:${RUN_ID}`, role: "assistant", content: "", timestamp: NOW,
    messageType: "agent_job_thread",
    metadata: { messageType: "agent_job_thread", jobId: RUN_ID, threadMessages },
  };
  const state = useAgentJobThreadPreviewState({ message, projectId: "project-1" });
  return state ? (
    <AgentJobThreadPreviewLayout
      {...state}
      branchThreads={[]}
      onOpenBranchThread={() => {}}
      MessageContent={MessageContent}
      ChatFileChangeList={() => null}
    />
  ) : null;
}

const TARGET = { runId: RUN_ID, runtimeId: "11111111-1111-4111-8111-111111111111", browserPageId: "page-of-the-job", runMetadata: {} };

/** ChatPanel's part: the context, and the end-of-transcript row when no turn claims the prompt. */
function Chat({ state, showTurn, threadMessages, tail = null }: {
  state: SharedBrowserApprovalState;
  showTurn: boolean;
  threadMessages: ChatMessage[];
  /** The last message the transcript shows, above the row. */
  tail?: ChatMessage | null;
}) {
  const { value, showFallback } = useTurnBrowserApprovalProvider({ target: TARGET, approval: state, agentName: "Octo" });
  return (
    <TurnBrowserApprovalContext.Provider value={value}>
      <TurnBrowserApprovalStateContext.Provider value={state}>
      {showTurn ? <Turn threadMessages={threadMessages} /> : null}
      {showFallback ? (
        <BrowserApprovalRow
          agentDisplayName="Octo"
          approval={state}
          onSettled={(entry) => value.recordSettled(RUN_ID, entry)}
          frame={(row) => (
            <ChatBubbleRow
              align="left"
              // As ChatPanel does: an avatar only when the row above is not the same run's.
              avatar={fallbackRowContinuesTail(tail, run())
                ? <span aria-hidden="true" data-testid="fallback-avatar-gutter" className="h-8 w-8" />
                : <span data-testid="fallback-avatar">O</span>}
              testId="browser-approval-fallback"
            >
              {row}
            </ChatBubbleRow>
          )}
        />
      ) : null}
      </TurnBrowserApprovalStateContext.Provider>
    </TurnBrowserApprovalContext.Provider>
  );
}

function step(
  id: string,
  timestamp: number,
  status: "in_progress" | "completed" | "failed",
  activity: Record<string, unknown> | null,
): ChatMessage {
  return {
    id: `${id}:${status}`, role: "assistant", authorId: null, content: "", timestamp, files: null,
    messageType: "mcp_tool_call",
    metadata: {
      source: "agent", outcome: "in_progress", kind: "update", jobId: RUN_ID,
      messageType: "mcp_tool_call",
      ...(activity ? { activity: { v: 1, also: [], count: 1, ...activity } } : {}),
      details: { itemId: id, status, server: "instafy_shared_browser", tool: "type" },
    },
  };
}

function reply(content: string, timestamp: number): ChatMessage {
  return {
    id: "reply", role: "assistant", authorId: null, content, timestamp, files: null,
    metadata: { source: "agent", outcome: "success", jobId: RUN_ID },
  };
}

const OPENED_CARRIS = step("item-open", NOW + 1_000, "completed", {
  key: "browser/open", role: "content", live: "Opening {host}",
  done: { one: "opened {host}", other: "opened {n} pages on {host}", some: "opened pages on {host}" },
  host: "carris.pt", pageKey: "aaaaaaaaaaaaaaaa", step: "navigate",
});
const SEARCH_LIVE = { key: "browser/browse", role: "quiet", live: "Browsing {host}", host: "visitlisboa.com", step: "submit" };
const SEARCHED = {
  key: "browser/search", role: "content", live: "Searching {host}",
  done: { one: "searched {host}", other: "searched {host} {n} times", some: "searched {host}" },
  host: "visitlisboa.com", pageKey: "bbbbbbbbbbbbbbbb", step: "search",
};

describe("a browser prompt inside Octo's turn", () => {
  it("renders inside the turn's preview, under its line, with no second avatar row", async () => {
    const pending = withPending(request());
    await act(async () => {
      root.render(<Chat state={pending} showTurn threadMessages={[OPENED_CARRIS, step("item-search", NOW + 2_000, "in_progress", SEARCH_LIVE)]} />);
    });
    await advance(BROWSER_APPROVAL_UNCLAIMED_FALLBACK_MS * 2);
    const preview = byTestId("agent-job-thread-preview")!;
    expect(preview.querySelector("[data-testid='browser-approval-row']")).not.toBeNull();
    expect(allByTestId("browser-approval-row")).toHaveLength(1);
    expect(byTestId("browser-approval-fallback")).toBeNull();
    expect(byTestId("chat-browser-approval-row")).toBeNull();
    // The line says the turn waits for the person who can answer.
    expect(byTestId("turn-activity-line")?.textContent).toContain("Waiting for you");
    // The row sits after the line.
    const line = byTestId("turn-activity")!;
    const row = byTestId("browser-approval-row")!;
    expect(line.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses into the turn's line once allowed, and leaves no answered card", async () => {
    const value = request();
    const threadMessages = [OPENED_CARRIS, step("item-search", NOW + 2_000, "in_progress", SEARCH_LIVE)];
    await act(async () => { root.render(<Chat state={withPending(value)} showTurn threadMessages={threadMessages} />); });
    await act(async () => {
      root.render(<Chat state={approval({ lastDecision: { approvalId: value.approvalId, decision: "allow_once" } })} showTurn threadMessages={threadMessages} />);
    });
    expect(byTestId("browser-approval-row")).toBeNull();
    expect(byTestId("chat-browser-approval-state")).toBeNull();
    expect(text()).not.toContain("Allowed");
    // The step ends as a search the person allowed; the turn ends.
    live.inFlight = false;
    const done = [
      OPENED_CARRIS,
      step("item-search", NOW + 2_000, "completed", { ...SEARCHED, approval: "once" }),
      reply("The Belém Tower opens at 10:00.", NOW + 3_000),
    ];
    await act(async () => { root.render(<Chat state={approval()} showTurn threadMessages={done} />); });
    // The last running label holds its moment before the done line.
    await advance(ACTIVITY_LABEL_HOLD_MS);
    expect(byTestId("turn-activity-line")?.textContent).toContain(
      "Opened carris.pt, searched visitlisboa.com · you allowed a search on visitlisboa.com",
    );
    await act(async () => { byTestId("turn-activity-line")!.click(); });
    expect(byTestId("turn-activity-approval")?.textContent).toBe("You allowed a search on visitlisboa.com");
  });

  it("collapses into a skipped step when nobody answered in time", async () => {
    const value = request();
    const running = [OPENED_CARRIS, step("item-search", NOW + 2_000, "in_progress", SEARCH_LIVE)];
    await act(async () => { root.render(<Chat state={withPending(value)} showTurn threadMessages={running} />); });
    await advance(120_000);
    expect(byTestId("browser-approval-row")).toBeNull();
    live.inFlight = false;
    const done = [
      OPENED_CARRIS,
      step("item-search", NOW + 2_000, "failed", { ...SEARCH_LIVE, approval: "expired" }),
      reply("I'm waiting for your OK to search visitlisboa.com.", NOW + 121_000),
    ];
    await act(async () => { root.render(<Chat state={approval()} showTurn threadMessages={done} />); });
    expect(byTestId("turn-activity-line")?.textContent).toContain(
      "Opened carris.pt · skipped a form on visitlisboa.com: no answer in time",
    );
  });

  it("says what was decided in this tab when the steps do not (an older runtime)", async () => {
    const value = request();
    const running = [OPENED_CARRIS, step("item-search", NOW + 2_000, "in_progress", null)];
    await act(async () => { root.render(<Chat state={withPending(value)} showTurn threadMessages={running} />); });
    await act(async () => {
      root.render(<Chat state={approval({ lastDecision: { approvalId: value.approvalId, decision: "deny" } })} showTurn threadMessages={running} />);
    });
    live.inFlight = false;
    const done = [OPENED_CARRIS, step("item-search", NOW + 2_000, "failed", null), reply("You declined, so I stopped.", NOW + 3_000)];
    await act(async () => { root.render(<Chat state={approval()} showTurn threadMessages={done} />); });
    await advance(ACTIVITY_LABEL_HOLD_MS);
    expect(byTestId("turn-activity-line")?.textContent).toContain(
      "Opened carris.pt · you said no to a form on visitlisboa.com",
    );
  });

  it("shows the fallback row's avatar only when the row above is not the same run's", async () => {
    // The run's own message is last (its turn is not on screen as a turn):
    // the row continues it with no second avatar.
    const ownMessage = reply("Looking up the tram.", NOW + 1_000);
    await act(async () => { root.render(<Chat state={withPending(request())} showTurn={false} threadMessages={[]} tail={ownMessage} />); });
    await advance(BROWSER_APPROVAL_UNCLAIMED_FALLBACK_MS);
    expect(byTestId("browser-approval-fallback")?.querySelector("[data-testid='browser-approval-row']")).not.toBeNull();
    expect(byTestId("fallback-avatar")).toBeNull();
    expect(byTestId("fallback-avatar-gutter")).not.toBeNull();
    // Someone else's message, or another run's, is last: the row shows Octo's avatar.
    const person: ChatMessage = { id: "person", role: "user", content: "Hi", timestamp: NOW + 2_000 };
    const otherRun: ChatMessage = { ...ownMessage, id: "other-run", metadata: { ...ownMessage.metadata, jobId: "55555555-5555-4555-8555-555555555555" } };
    for (const tail of [person, otherRun]) {
      await act(async () => { root.render(<Chat state={withPending(request())} showTurn={false} threadMessages={[]} tail={tail} />); });
      expect(byTestId("fallback-avatar")).not.toBeNull();
      expect(byTestId("fallback-avatar-gutter")).toBeNull();
    }
  });

  it("shows the prompt at the end of the chat when no turn claims it", async () => {
    await act(async () => { root.render(<Chat state={withPending(request())} showTurn={false} threadMessages={[]} />); });
    expect(byTestId("browser-approval-fallback")).toBeNull();
    await advance(BROWSER_APPROVAL_UNCLAIMED_FALLBACK_MS);
    const fallback = byTestId("browser-approval-fallback")!;
    expect(fallback.querySelector("[data-testid='browser-approval-row']")).not.toBeNull();
    expect(byTestId("fallback-avatar")).not.toBeNull();
    // Once the run's turn is on screen, the prompt moves into it.
    await act(async () => {
      root.render(<Chat state={withPending(request())} showTurn threadMessages={[OPENED_CARRIS, step("item-search", NOW + 2_000, "in_progress", SEARCH_LIVE)]} />);
    });
    expect(byTestId("browser-approval-fallback")).toBeNull();
    expect(allByTestId("browser-approval-row")).toHaveLength(1);
  });
});

describe("fallbackRowContinuesTail", () => {
  it("is true only under an assistant message of the prompt's own run", () => {
    const own = reply("Looking up the tram.", NOW);
    expect(fallbackRowContinuesTail(own, run())).toBe(true);
    expect(fallbackRowContinuesTail({ ...own, metadata: { ...own.metadata, jobId: "someone-else" } }, run())).toBe(false);
    expect(fallbackRowContinuesTail({ ...own, role: "user" }, run())).toBe(false);
    expect(fallbackRowContinuesTail({ ...own, metadata: {} }, run())).toBe(false);
    expect(fallbackRowContinuesTail(null, run())).toBe(false);
    expect(fallbackRowContinuesTail(own, null)).toBe(false);
  });
});
