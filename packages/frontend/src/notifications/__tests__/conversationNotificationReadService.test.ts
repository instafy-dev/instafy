import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), context: vi.fn() }));
vi.mock("../../services/runtimeController/client", () => ({ controllerJsonRequest: mocks.request }));
vi.mock("../../services/runtimeController/core", () => ({ resolveControllerRequestContext: mocks.context }));
import { readConversationProductNotifications } from "../../services/runtimeController/productNotifications";
const ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";
const params = () => ({ conversationId: ID, messageIds: [MESSAGE], expectedUserId: ID, accessToken: "captured-token", isCurrent: () => true });
beforeEach(() => { vi.clearAllMocks(); mocks.context.mockResolvedValue({ baseUrl: "https://controller.example.test", accessToken: "captured-token" }); mocks.request.mockResolvedValue({ success: true, value: { ok: true } }); });
describe("conversation notification read account binding", () => {
  it("sends exact source IDs and expected identity using the captured request context", async () => {
    await readConversationProductNotifications(params());
    expect(mocks.context).toHaveBeenCalledWith("captured-token");
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      path: "/me/notifications/conversation-read", method: "POST",
      requestContext: { baseUrl: "https://controller.example.test", accessToken: "captured-token" },
      body: { conversationId: ID, messageIds: [MESSAGE], expectedUserId: ID },
    }));
  });
  it("does not send with a replacement controller token or after asynchronous account change", async () => {
    mocks.context.mockResolvedValueOnce({ baseUrl: "https://controller.example.test", accessToken: "different-token" });
    await expect(readConversationProductNotifications(params())).rejects.toThrow("session changed");
    let current = true;
    mocks.context.mockImplementationOnce(async () => { current = false; return { baseUrl: "https://controller.example.test", accessToken: "captured-token" }; });
    await expect(readConversationProductNotifications({ ...params(), isCurrent: () => current })).rejects.toThrow("session changed");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([{ messageIds: [] }, { messageIds: ["local-synthetic-id"] }, { messageIds: Array.from({ length: 101 }, () => MESSAGE) }])("rejects empty, synthetic or oversized message batches", async ({ messageIds }) => {
    await expect(readConversationProductNotifications({ ...params(), messageIds })).rejects.toThrow("Invalid conversation");
    expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("requires a positive response before treating a source observation as acknowledged", async () => {
    mocks.request.mockResolvedValueOnce({ success: true, value: { ok: false } });
    await expect(readConversationProductNotifications(params())).rejects.toThrow("response");
  });
});
