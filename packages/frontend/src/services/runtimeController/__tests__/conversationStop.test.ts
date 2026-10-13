import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn());
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: context,
  readControllerError: vi.fn(async () => "Access denied"),
}));
import { stopConversationJobs } from "../conversationStop";

describe("stopConversationJobs", () => {
  beforeEach(() => context.mockResolvedValue({ baseUrl: "https://controller.invalid", accessToken: "fixture-token" }));
  afterEach(() => vi.unstubAllGlobals());
  it("posts one exact job set with authentication and preserves already-finished results", async () => {
    const result = { ok: true, canceledJobIds: ["j1"], canceledRunIds: ["r1"], alreadyFinishedJobIds: ["j2"] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result))); vi.stubGlobal("fetch", fetchMock);
    await expect(stopConversationJobs("chat/one", ["j1", "j2", "j1"])).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://controller.invalid/conversations/chat%2Fone/stop", expect.objectContaining({
      method: "POST", body: JSON.stringify({ jobIds: ["j1", "j2"] }), headers: expect.objectContaining({ authorization: "Bearer fixture-token" }),
    }));
  });
  it("fails authentication and refused requests without attempting a conversation-wide fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 403 })); vi.stubGlobal("fetch", fetchMock);
    await expect(stopConversationJobs("chat", ["j1"])).rejects.toThrow("Access denied"); expect(fetchMock).toHaveBeenCalledTimes(1);
    context.mockResolvedValue({ accessToken: null });
    await expect(stopConversationJobs("chat", ["j1"])).rejects.toThrow("Sign in"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
