import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), context: vi.fn() }));
vi.mock("../client", () => ({ controllerJsonRequest: mocks.request }));
vi.mock("../core", () => ({ resolveControllerRequestContext: mocks.context }));
import { updateProductNotificationState } from "../productNotifications";
const id = "11111111-1111-4111-8111-111111111111";
const expectedUserId = "22222222-2222-4222-8222-222222222222";
const pin = { id, action: "read" as const, accessToken: "pinned-token", expectedUserId, isCurrent: () => true };
beforeEach(() => { vi.clearAllMocks(); mocks.context.mockResolvedValue({ baseUrl: "http://local.test", accessToken: "pinned-token" }); mocks.request.mockResolvedValue({ success: true }); });
describe("account-pinned notification state", () => {
  it("sends the resolved pinned request context and expected account", async () => {
    await updateProductNotificationState(pin);
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestContext: { baseUrl: "http://local.test", accessToken: "pinned-token" }, body: { id, action: "read", expectedUserId } }));
  });
  it("rejects a custom binding token replacement before sending", async () => {
    mocks.context.mockResolvedValue({ baseUrl: "http://other.test", accessToken: "another-account-token" });
    await expect(updateProductNotificationState(pin)).rejects.toThrow("session changed");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects a session switch while resolving credentials", async () => {
    let active = true;
    mocks.context.mockImplementation(async () => { active = false; return { baseUrl: "http://local.test", accessToken: "pinned-token" }; });
    await expect(updateProductNotificationState({ ...pin, isCurrent: () => active })).rejects.toThrow("session changed");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
