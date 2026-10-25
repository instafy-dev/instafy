// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserInputRequest } from "../../../../services/runtimeController/userInputRequests";
import { UserInputRequestEntry } from "../UserInputRequestEntry";
import { useWorkerQuestionReply, WorkerQuestionReplyContext, WorkerQuestionReplyStrip } from "../WorkerQuestionReply";

const api = vi.hoisted(() => ({ getUserInputRequest: vi.fn(), answerUserInputRequest: vi.fn() }));
vi.mock("../../../../services/runtimeController/userInputRequests", () => api);
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const request = (status: UserInputRequest["status"] = "pending", requestId = REQUEST_ID): UserInputRequest => ({ requestId, messageId: MESSAGE_ID, status, canAnswer: status === "pending", agentHandle: "@poet",
  questions: [{ id: "tone", header: "Tone", question: "Which tone?", options: [{ label: "Warm", description: "A friendly poem" }] }] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let reply: ReturnType<typeof useWorkerQuestionReply>;
function Harness({ scope = "chat-a", id = REQUEST_ID, attachments = false, second = false, canSelect }: { scope?: string; id?: string; attachments?: boolean; second?: boolean; canSelect?: () => boolean }) {
  const [draft, setDraft] = useState("");
  reply = useWorkerQuestionReply({ scope, readDraft: () => draft, writeDraft: setDraft, focusComposer: () => {}, hasAttachments: attachments, canSelect });
  return <WorkerQuestionReplyContext.Provider value={reply.host}>
    <UserInputRequestEntry requestId={id} messageId={MESSAGE_ID} taskLabel="Garden poem" />
    {second ? <UserInputRequestEntry requestId={OTHER_ID} messageId={MESSAGE_ID} taskLabel="Moon poem" /> : null}
    <WorkerQuestionReplyStrip reply={reply} />
    <textarea aria-label="Usual composer" value={draft} onChange={event => setDraft(event.currentTarget.value)} />
    <button onClick={() => void reply.submit(draft)}>Send</button>
  </WorkerQuestionReplyContext.Provider>;
}

describe("worker question through the usual composer", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); vi.resetAllMocks(); api.getUserInputRequest.mockResolvedValue(request());
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const render = async (props: Parameters<typeof Harness>[0] = {}) => act(async () => root.render(<Harness {...props} />));
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === label)!;
  const input = () => container.querySelector("textarea")!;
  const click = async (element: HTMLElement) => act(async () => element.click());
  const select = async () => click(button("Reply"));
  async function write(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const tick = async (ms = 5000) => act(async () => vi.advanceTimersByTimeAsync(ms));

  it("shows ordinary question text without a card, duplicate attribution or embedded input", async () => {
    await render();
    const message = container.querySelector('[data-testid="user-input-request-message"]')!;
    expect(message.textContent).toContain("Which tone?");
    expect(message.textContent).not.toContain("Question from");
    expect(message.querySelector("input,textarea")).toBeNull();
    expect(container.querySelector('[data-testid="worker-question-reply"]')).toBeNull();
    expect(api.answerUserInputRequest).not.toHaveBeenCalled();
  });

  it("sends a chosen option/freeform answer only to its explicit controller target once", async () => {
    const pending = deferred<UserInputRequest>(); api.answerUserInputRequest.mockReturnValue(pending.promise);
    await render(); await select();
    expect(container.textContent).toContain("Replying to Garden poem");
    await click(button("Warm")); expect(input().value).toBe("Warm");
    expect(api.answerUserInputRequest).not.toHaveBeenCalled();
    await write("Warm, with a little humor");
    await act(async () => { button("Send").click(); button("Send").click(); });
    expect(api.answerUserInputRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, MESSAGE_ID, { tone: ["Warm, with a little humor"] }, expect.any(AbortSignal));
    api.getUserInputRequest.mockResolvedValue(request("answered"));
    await act(async () => pending.resolve(request("answered")));
    expect(input().value).toBe(""); expect(reply.active).toBeNull();
    expect(container.textContent).toContain("Answer saved");
    api.getUserInputRequest.mockResolvedValue(request("resumed")); await tick();
    expect(container.textContent).toContain("Answered");
    const reads = api.getUserInputRequest.mock.calls.length; await tick(60000);
    expect(api.getUserInputRequest).toHaveBeenCalledTimes(reads);
  });

  it("ignores a stale pending poll after the answer is confirmed", async () => {
    await render(); await select(); await write("Warm");
    const stale = deferred<UserInputRequest>(); api.getUserInputRequest.mockReturnValueOnce(stale.promise); await tick();
    const signal = api.getUserInputRequest.mock.lastCall![2] as AbortSignal;
    const sending = deferred<UserInputRequest>(); api.answerUserInputRequest.mockReturnValueOnce(sending.promise);
    await click(button("Send"));
    api.getUserInputRequest.mockResolvedValue(request("resumed"));
    await act(async () => sending.resolve(request("resumed")));
    expect(signal.aborted).toBe(true);
    await act(async () => stale.resolve(request()));
    expect(button("Reply")).toBeUndefined(); expect(container.textContent).toContain("Answered");
  });

  it("keeps the draft and binding after a failed submission without retrying automatically", async () => {
    api.answerUserInputRequest.mockRejectedValue(new Error("Forbidden"));
    await render(); await select(); await write("A quiet poem"); await click(button("Send"));
    expect(input().value).toBe("A quiet poem"); expect(reply.active?.request.requestId).toBe(REQUEST_ID);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
    await tick(); expect(api.answerUserInputRequest).toHaveBeenCalledTimes(1);
  });

  it("collects multiple questions sequentially and submits a complete ID-bound answer set", async () => {
    api.getUserInputRequest.mockResolvedValue({ ...request(), questions: [request().questions[0], { id: "__proto__", header: "Length", question: "How long?" }] });
    await render(); await select(); await write("Warm"); await click(button("Send"));
    expect(api.answerUserInputRequest).not.toHaveBeenCalled(); expect(input().value).toBe("");
    expect(container.textContent).toContain("2 of 2"); await write("Four lines");
    api.answerUserInputRequest.mockResolvedValue(request("answered")); await click(button("Send"));
    expect(api.answerUserInputRequest.mock.lastCall?.[2]).toEqual(JSON.parse('{"tone":["Warm"],"__proto__":["Four lines"]}'));
  });

  it("can revisit staged answers and preserves them as a draft when cancelling", async () => {
    api.getUserInputRequest.mockResolvedValue({ ...request(), questions: [request().questions[0], { id: "length", header: "Length", question: "How long?" }] });
    await render(); await select(); await write("Warm"); await click(button("Send")); await write("Four lines");
    await click(button("Back")); expect(input().value).toBe("Warm");
    await write("Quiet"); await click(button("Send")); expect(input().value).toBe("Four lines");
    await act(async () => reply.cancel());
    expect(input().value).toBe("Tone: Quiet\n\nLength: Four lines");
    expect(reply.active).toBeNull(); expect(api.answerUserInputRequest).not.toHaveBeenCalled();
  });

  it("restores staged question progress when returning to its own chat", async () => {
    api.getUserInputRequest.mockResolvedValue({ ...request(), questions: [request().questions[0], { id: "length", header: "Length", question: "How long?" }] });
    await render(); await select(); await write("Warm"); await click(button("Send"));
    await render({ scope: "chat-b" }); expect(reply.active).toBeNull();
    await render(); expect(reply.active?.index).toBe(1);
    await click(button("Back")); expect(input().value).toBe("Warm");
    expect(api.answerUserInputRequest).not.toHaveBeenCalled();
  });

  it("confirms a saved answer after a lost POST response without resubmitting it", async () => {
    api.answerUserInputRequest.mockRejectedValue(new Error("Connection lost"));
    await render(); await select(); await write("Quiet"); await click(button("Send"));
    api.getUserInputRequest.mockResolvedValue({ ...request("resumed"), answers: { tone: ["Quiet"] } });
    await tick(); await click(button("Send"));
    expect(api.answerUserInputRequest).toHaveBeenCalledTimes(1); expect(input().value).toBe(""); expect(reply.active).toBeNull();
  });

  it("never offers teammates or read-only trace views an answer action", async () => {
    api.getUserInputRequest.mockResolvedValue({ ...request(), canAnswer: false }); await render();
    expect(button("Reply")).toBeUndefined(); expect(container.textContent).toContain("Waiting for the person");
    api.getUserInputRequest.mockResolvedValue(request());
    await act(async () => root.render(<UserInputRequestEntry requestId={REQUEST_ID} messageId={MESSAGE_ID} />));
    expect(button("Reply")).toBeUndefined(); expect(api.answerUserInputRequest).not.toHaveBeenCalled();
  });

  it("preserves a queued edit when worker selection is blocked and allows Reply after cancelling the edit", async () => {
    const canSelect = vi.fn().mockReturnValue(false);
    await render({ canSelect }); await write("My queued message edit"); await select();
    expect(canSelect).toHaveBeenCalledOnce();
    expect(reply.active).toBeNull();
    expect(input().value).toBe("My queued message edit");
    expect(container.textContent).not.toContain("Replying to");
    expect(api.answerUserInputRequest).not.toHaveBeenCalled();
    canSelect.mockReturnValue(true);
    await select(); await write("Warm");
    api.answerUserInputRequest.mockResolvedValue(request("resumed"));
    await click(button("Send"));
    expect(api.answerUserInputRequest.mock.lastCall?.slice(0, 3)).toEqual([REQUEST_ID, MESSAGE_ID, { tone: ["Warm"] }]);
  });

  it("prevents a second question from stealing the current draft and routes it after explicit cancellation", async () => {
    api.getUserInputRequest.mockImplementation(async (id: string) => request("pending", id));
    await render({ second: true }); await select(); await write("Garden answer");
    const replies = container.querySelectorAll('[data-testid="user-input-request-reply"]');
    await click(replies[1] as HTMLElement); expect(reply.active?.request.requestId).toBe(REQUEST_ID);
    expect(input().value).toBe("Garden answer");
    await act(async () => reply.cancel()); await click(replies[1] as HTMLElement);
    await write("Moon answer"); api.answerUserInputRequest.mockResolvedValue(request("resumed", OTHER_ID)); await click(button("Send"));
    expect(api.answerUserInputRequest.mock.lastCall?.slice(0,3)).toEqual([OTHER_ID, MESSAGE_ID, { tone: ["Moon answer"] }]);
  });

  it("rechecks revoked access before sending and retains the draft", async () => {
    await render(); await select(); await write("My answer");
    api.getUserInputRequest.mockResolvedValue({ ...request(), canAnswer: false }); await click(button("Send"));
    expect(api.answerUserInputRequest).not.toHaveBeenCalled(); expect(input().value).toBe("My answer");
    expect(reply.active).not.toBeNull(); expect(container.textContent).toContain("no longer available");
  });

  it("does not discard attachments or allow a worker reply to become a queued/stashed chat send", async () => {
    await render({ attachments: true }); await select(); await write("Attached answer"); await click(button("Send"));
    expect(api.answerUserInputRequest).not.toHaveBeenCalled(); expect(input().value).toBe("Attached answer");
    expect(container.textContent).toContain("Remove the attached images");
    await render(); await act(async () => { await reply.submit("Attached answer", "queue"); await reply.submit("Attached answer", "stash"); });
    expect(api.answerUserInputRequest).not.toHaveBeenCalled(); expect(reply.active).not.toBeNull();
  });

  it("does not erase a newer draft while the answer is sending", async () => {
    const pending = deferred<UserInputRequest>(); api.answerUserInputRequest.mockReturnValue(pending.promise);
    await render(); await select(); await write("First answer"); await click(button("Send")); await write("Next message");
    await act(async () => pending.resolve(request("resumed")));
    expect(input().value).toBe("Next message"); expect(reply.active).toBeNull();
  });

  it("aborts and ignores an old response after switching conversations", async () => {
    const pending = deferred<UserInputRequest>(); api.answerUserInputRequest.mockReturnValue(pending.promise);
    await render(); await select(); await write("Old answer"); await click(button("Send"));
    const signal = api.answerUserInputRequest.mock.lastCall![3] as AbortSignal;
    await render({ scope: "chat-b" }); await write("New chat draft");
    expect(signal.aborted).toBe(true); expect(reply.active).toBeNull();
    await act(async () => pending.resolve(request("resumed")));
    expect(input().value).toBe("New chat draft"); expect(reply.active).toBeNull();
  });

  it("bounds status retries and aborts an unmounted read", async () => {
    api.getUserInputRequest.mockRejectedValue(new Error("Unavailable")); await render();
    await tick(5000); await tick(15000); await tick(30000); await tick(60000);
    expect(api.getUserInputRequest).toHaveBeenCalledTimes(4); expect(container.textContent).toContain("Question unavailable");
    const pending = deferred<UserInputRequest>(); api.getUserInputRequest.mockReturnValueOnce(pending.promise);
    await click(button("Check status")); const signal = api.getUserInputRequest.mock.lastCall![2] as AbortSignal;
    await act(async () => root.unmount()); root = createRoot(container);
    expect(signal.aborted).toBe(true); await act(async () => pending.resolve(request())); expect(container.textContent).toBe("");
  });

  it("shows expiration and preserves an in-progress selected draft", async () => {
    await render(); await select(); await write("Unsaved answer");
    api.getUserInputRequest.mockResolvedValue({ ...request("expired"), expiredReason: "The team time budget ended." }); await tick();
    expect(container.textContent).toContain("time budget ended"); expect(button("Reply")).toBeUndefined();
    await click(button("Send")); expect(api.answerUserInputRequest).not.toHaveBeenCalled(); expect(input().value).toBe("Unsaved answer");
  });
});
