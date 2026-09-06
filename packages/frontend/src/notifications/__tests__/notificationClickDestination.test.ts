// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const updateState = vi.hoisted(() => vi.fn());
vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: { updateState } } }));
import { processNotificationClickDestination } from "../notificationClickDestination";
import { buildNotificationClickUrl, parseNotificationClickUrl } from "../notificationContract";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const REPORT = "33333333-3333-4333-8333-333333333333";
const resourceUrl = `/studio?supportReportId=${REPORT}`;
const url = buildNotificationClickUrl({ url: resourceUrl, eventId: EVENT, accountId: ACCOUNT })!;
beforeEach(() => { vi.clearAllMocks(); updateState.mockResolvedValue(undefined); });
const options = () => ({ url, userId: ACCOUNT, accessToken: "owner-token", isCurrent: () => true, openResource: vi.fn() });
describe("authenticated external notification click consumption", () => {
  it("retains validated identity during a cold start and acknowledges only after login opens the report", async () => {
    const input = options();
    expect(parseNotificationClickUrl(url)).toEqual({ resourceUrl, eventId: EVENT, accountId: ACCOUNT });
    expect(await processNotificationClickDestination({ ...input, userId: null, accessToken: null })).toEqual({ status: "pending", resourceUrl });
    expect(input.openResource).not.toHaveBeenCalled(); expect(updateState).not.toHaveBeenCalled();
    expect(await processNotificationClickDestination(input)).toEqual({ status: "opened", resourceUrl });
    expect(input.openResource).toHaveBeenCalledWith(resourceUrl);
    expect(updateState).toHaveBeenCalledWith({ id: EVENT, action: "read", accessToken: "owner-token" });
    expect(input.openResource.mock.invocationCallOrder[0]).toBeLessThan(updateState.mock.invocationCallOrder[0]);
  });
  it("never opens or acknowledges another account's notification after login", async () => {
    const input = options();
    expect((await processNotificationClickDestination({ ...input, userId: EVENT })).status).toBe("ignored");
    expect(input.openResource).not.toHaveBeenCalled(); expect(updateState).not.toHaveBeenCalled();
  });
  it("does not acknowledge before destination processing finishes or after an intervening account switch", async () => {
    let finish: (() => void) | undefined; let current = true;
    const pending = processNotificationClickDestination({ ...options(), isCurrent: () => current, openResource: () => new Promise<void>((resolve) => { finish = resolve; }) });
    expect(updateState).not.toHaveBeenCalled(); current = false; finish?.();
    expect((await pending).status).toBe("ignored"); expect(updateState).not.toHaveBeenCalled();
  });
  it.each([
    url + `&notificationEventId=${EVENT}`,
    url.replace(`notificationEventId=${EVENT}`, "notificationEventId=invalid"),
    url.replace(`notificationAccountId=${ACCOUNT}`, "notificationAccountId=invalid"),
    url + "&controllerAccessToken=secret",
    url.replace("/studio?", "/login?"),
    "https://evil.invalid" + url,
  ])("rejects invalid resource/metadata without acknowledging: %s", async (invalidUrl) => {
    const input = options();
    expect((await processNotificationClickDestination({ ...input, url: invalidUrl })).status).toBe("ignored");
    expect(updateState).not.toHaveBeenCalled(); expect(input.openResource).not.toHaveBeenCalled();
  });
  it("leaves metadata available to retry an acknowledgement failure, without advancing support cursors", async () => {
    const input = options(); updateState.mockRejectedValueOnce(new Error("Offline"));
    await expect(processNotificationClickDestination(input)).rejects.toThrow("Offline");
    expect(input.url).toBe(url);
    expect((await processNotificationClickDestination(input)).status).toBe("opened");
    expect(updateState).toHaveBeenCalledTimes(2);
    expect(updateState.mock.calls.every(([state]) => state.action === "read" && state.id === EVENT)).toBe(true);
  });
});
