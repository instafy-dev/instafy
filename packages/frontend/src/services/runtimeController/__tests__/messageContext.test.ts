import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMessageContext, MessageContextUnavailableError } from "../messageContext";
import { resolveControllerRequestContext } from "../core";

vi.mock("../core", () => ({ runtimeControllerEnabled: true, resolveControllerRequestContext: vi.fn(), readControllerError: vi.fn() }));
const params = { projectId: "project", conversationId: "conversation", messageId: "target", signal: new AbortController().signal };
const responsePage = () => ({ anchorMessageId: "target", messages: [{
  id: "target", conversationId: "conversation", projectId: "project", role: "user", content: "Stored message", createdAt: "2026-09-10T10:00:00Z", metadata: null,
}], olderCursor: "target", newerCursor: "target", hasOlder: true, hasNewer: true });

describe("authenticated message context reads", () => {
  beforeEach(() => {
    vi.mocked(resolveControllerRequestContext).mockReset();
    vi.mocked(resolveControllerRequestContext).mockResolvedValue({ baseUrl: "https://controller.invalid", accessToken: "inert-test-session" } as Awaited<ReturnType<typeof resolveControllerRequestContext>>);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(responsePage()), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the current authorized binding and the exact conversation/message context path", async () => {
    const page = await fetchMessageContext(params);
    expect(page.anchorMessageId).toBe("target");
    expect(resolveControllerRequestContext).toHaveBeenCalledWith(null);
    expect(fetch).toHaveBeenCalledWith("https://controller.invalid/conversations/conversation/messages/context?messageId=target&before=20&after=20", expect.objectContaining({
      headers: { authorization: "Bearer inert-test-session" }, signal: expect.any(AbortSignal),
    }));
  });

  it.each(["projectId", "conversationId", "id"] as const)("rejects a returned target from the wrong %s", async (field) => {
    const page = responsePage(); page.messages[0][field] = "different";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));
    await expect(fetchMessageContext(params)).rejects.toThrow("Unable to read");
  });

  it.each([403, 404])("reports %s without retaining message data", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status }));
    await expect(fetchMessageContext(params)).rejects.toBeInstanceOf(MessageContextUnavailableError);
  });

  it("does not start a GET if navigation cancels while credentials are resolving", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof resolveControllerRequestContext>>) => void;
    vi.mocked(resolveControllerRequestContext).mockReturnValue(new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const pending = fetchMessageContext({ ...params, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolve({ baseUrl: "https://controller.invalid", accessToken: "inert-test-session" } as Awaited<ReturnType<typeof resolveControllerRequestContext>>);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});
