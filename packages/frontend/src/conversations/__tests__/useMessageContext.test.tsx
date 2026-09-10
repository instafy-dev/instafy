// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageContext, type MessageContextTarget } from "../useMessageContext";
import { fetchMessageContext, MessageContextUnavailableError, type MessageContextPage } from "../../services/runtimeController/messageContext";

vi.mock("../../services/runtimeController/messageContext", () => ({
  fetchMessageContext: vi.fn(), MessageContextUnavailableError: class extends Error { constructor(message: string, readonly accessDenied = false) { super(message); } },
}));
const target: MessageContextTarget = { userId: "user-a", projectId: "project-a", conversationId: "chat-a", messageId: "middle", visitKey: "visit-a" };
function page(ids: string[], overrides: Partial<MessageContextPage> = {}): MessageContextPage {
  return { anchorMessageId: "middle", messages: ids.map((id) => ({
    id, conversationId: "chat-a", projectId: "project-a", sessionId: null, promptId: null, runId: null,
    role: "user", content: id, metadata: null, createdAt: "2026-09-10T10:00:00Z",
  })), olderCursor: ids.at(-1) ?? null, newerCursor: ids[0] ?? null, hasOlder: true, hasNewer: true, ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("targeted message context", () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: ReturnType<typeof useMessageContext>;
  function Probe({ selected }: { selected: MessageContextTarget | null }) { api = useMessageContext(selected); return <div>{api.messages.map((message) => message.content).join(",")}</div>; }
  async function render(selected: MessageContextTarget | null = target) { await act(async () => root.render(<Probe selected={selected} />)); }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(fetchMessageContext).mockReset();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

  it("loads the exact scoped target, then extends both boundaries with deduplicated anchors", async () => {
    vi.mocked(fetchMessageContext).mockResolvedValueOnce(page(["new", "middle", "old"]))
      .mockResolvedValueOnce(page(["old", "older"], { hasOlder: false }))
      .mockResolvedValueOnce(page(["newest", "new"], { hasNewer: false }));
    await render();
    expect(fetchMessageContext).toHaveBeenNthCalledWith(1, expect.objectContaining(target));
    expect(api.messages.map((message) => message.id)).toEqual(["old", "middle", "new"]);
    await act(async () => api.loadOlder());
    expect(fetchMessageContext).toHaveBeenNthCalledWith(2, expect.objectContaining({ messageId: "old", before: 40, after: 0 }));
    await act(async () => api.loadNewer());
    expect(fetchMessageContext).toHaveBeenNthCalledWith(3, expect.objectContaining({ messageId: "new", before: 0, after: 40 }));
    expect(api.messages.map((message) => message.id)).toEqual(["older", "old", "middle", "new", "newest"]);
    expect(api.hasOlder).toBe(false); expect(api.hasNewer).toBe(false);
  });

  it.each([
    { ...target, userId: "user-b" },
    { ...target, projectId: "project-b", conversationId: "chat-b" },
    { ...target, messageId: "second", visitKey: "visit-b" },
    null,
  ])("cancels and ignores a late result when target scope changes: %j", async (next) => {
    const pending = deferred<MessageContextPage>();
    vi.mocked(fetchMessageContext).mockReturnValueOnce(pending.promise).mockResolvedValue(page(["second"]));
    await render();
    const signal = vi.mocked(fetchMessageContext).mock.calls[0][0].signal;
    await render(next);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(page(["middle"])));
    expect(container.textContent).toBe(next ? "second" : "");
  });

  it("clears the targeted window on revoked access during pagination", async () => {
    vi.mocked(fetchMessageContext).mockResolvedValueOnce(page(["middle", "old"]))
      .mockRejectedValueOnce(new MessageContextUnavailableError("Unavailable", true));
    await render();
    await act(async () => api.loadOlder());
    expect(api.messages).toEqual([]); expect(api.unavailable).toBe(true);
    expect(api.accessDenied).toBe(true);
    await act(async () => api.loadNewer());
    expect(fetchMessageContext).toHaveBeenCalledTimes(2);
  });

  it("keeps the readable window on a transient page error and retries the same boundary", async () => {
    vi.mocked(fetchMessageContext).mockResolvedValueOnce(page(["middle", "old"]))
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValueOnce(page(["old", "older"], { hasOlder: false }));
    await render();
    await act(async () => api.loadOlder());
    expect(api.messages.map((message) => message.id)).toEqual(["old", "middle"]);
    expect(api.error).toBe("Try again");
    await act(async () => api.loadOlder());
    expect(api.messages.map((message) => message.id)).toEqual(["older", "old", "middle"]);
    expect(api.error).toBeNull();
  });
});
