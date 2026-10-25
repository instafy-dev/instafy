import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerUserInputRequest, getUserInputRequest } from "../userInputRequests";

const controller = vi.hoisted(() => ({ context: vi.fn(), error: vi.fn(), enabled: true }));
vi.mock("../core", () => ({
  get runtimeControllerEnabled() { return controller.enabled; },
  resolveControllerRequestContext: controller.context,
  readControllerError: controller.error,
}));
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const request = () => ({ requestId: REQUEST_ID, messageId: MESSAGE_ID, status: "pending", canAnswer: true, agentHandle: "@poet",
  questions: [{ id: "tone", header: "Tone", question: "Which tone?", options: [{ label: "Warm", description: "A friendly poem" }] }] });

describe("durable user input controller client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks(); controller.enabled = true;
    controller.context.mockResolvedValue({ baseUrl: "https://controller.invalid", accessToken: "fixture-token" });
    controller.error.mockResolvedValue("Question unavailable");
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const respond = (value: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value)));

  it("reads and answers only the exact request with the current controller credentials", async () => {
    const abort = new AbortController(); respond(request());
    await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID, abort.signal)).resolves.toEqual(request());
    expect(fetchMock).toHaveBeenLastCalledWith(`https://controller.invalid/user-input-requests/${REQUEST_ID}`,
      expect.objectContaining({ method: "GET", signal: abort.signal, headers: expect.objectContaining({ authorization: "Bearer fixture-token" }) }));
    controller.context.mockResolvedValueOnce({ baseUrl: "https://controller-two.invalid", accessToken: "next-token" });
    respond({ ...request(), status: "answered", answers: { tone: ["Warm"] } });
    await expect(answerUserInputRequest(REQUEST_ID, MESSAGE_ID, { tone: ["Warm"] }, abort.signal)).resolves.toMatchObject({ status: "answered" });
    expect(fetchMock).toHaveBeenLastCalledWith(`https://controller-two.invalid/user-input-requests/${REQUEST_ID}/answer`,
      expect.objectContaining({ method: "POST", signal: abort.signal, body: JSON.stringify({ answers: { tone: ["Warm"] } }),
        headers: expect.objectContaining({ authorization: "Bearer next-token" }) }));
    expect(controller.context.mock.calls).toEqual([[null], [null]]);
  });

  it("rejects mismatched, secret, duplicate and unbounded questions rather than offering an unsafe action", async () => {
    for (const value of [
      { ...request(), requestId: OTHER_ID }, { ...request(), messageId: OTHER_ID }, { ...request(), status: "done" }, { ...request(), status: ["pending"] },
      { ...request(), questions: [{ ...request().questions[0], isSecret: true }] },
      { ...request(), questions: [request().questions[0], request().questions[0]] },
      { ...request(), questions: [{ ...request().questions[0], question: "q".repeat(2001) }] },
      { ...request(), questions: [{ ...request().questions[0], options: [request().questions[0].options[0], request().questions[0].options[0]] }] },
      { ...request(), questions: [{ ...request().questions[0], id: " tone " }] },
      { ...request(), answers: { another: ["Warm"] } },
    ]) {
      respond(value); await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID)).rejects.toThrow("unreadable");
    }
  });

  it("strips internal targets and refuses invalid IDs or answers before sending anything", async () => {
    respond({ ...request(), jobId: "untrusted-job", threadId: "untrusted-thread", provider: "untrusted-provider" });
    await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID)).resolves.toEqual(request());
    fetchMock.mockClear();
    await expect(getUserInputRequest("../jobs/other", MESSAGE_ID)).rejects.toThrow("unavailable");
    const invalidAnswers: Array<Record<string, string[]>> = [{}, { tone: [""] }, { tone: ["one", "two"] }, { tone: ["🌟".repeat(4001)] }];
    for (const answers of invalidAnswers) {
      await expect(answerUserInputRequest(REQUEST_ID, MESSAGE_ID, answers)).rejects.toThrow("one answer");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the controller's expiry explanation and accepts bounded Unicode answers", async () => {
    const value = { ...request(), status: "expired", expiredReason: "This assignment was canceled." }; respond(value);
    await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID)).resolves.toEqual(value);
    const answers = { tone: ["🌟".repeat(4000)] }; respond({ ...request(), status: "answered", answers });
    await expect(answerUserInputRequest(REQUEST_ID, MESSAGE_ID, answers)).resolves.toMatchObject({ status: "answered", answers });
  });

  it("does not turn access errors, missing auth or aborted requests into success", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(answerUserInputRequest(REQUEST_ID, MESSAGE_ID, { tone: ["Warm"] })).rejects.toThrow("Question unavailable");
    const abort = new AbortController(); abort.abort();
    await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.context.mockResolvedValueOnce({ baseUrl: "https://controller.invalid", accessToken: null });
    await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID)).rejects.toThrow("session token");
    controller.enabled = false;
    await expect(getUserInputRequest(REQUEST_ID, MESSAGE_ID)).rejects.toThrow("not configured");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
