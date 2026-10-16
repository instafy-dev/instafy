import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn());
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: context,
  readControllerError: vi.fn(async () => "Group unavailable"),
}));
import { fetchPlanGroupStatus } from "../jobs";

describe("historical plan group status", () => {
  beforeEach(() => context.mockResolvedValue({ baseUrl: "https://controller.invalid", accessToken: "fixture-token" }));
  afterEach(() => vi.unstubAllGlobals());
  it("reads the exact authorized group with an abort signal and retains never-leased cancellation", async () => {
    const result = { groupId: "group/one", workers: [{ jobId: "job-ten", handle: "poet10", status: "canceled", leaseMetrics: { leasedAt: null } }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result))); vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    await expect(fetchPlanGroupStatus("group/one", abort.signal)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://controller.invalid/agent/plan-groups/group%2Fone/status", {
      signal: abort.signal, headers: { authorization: "Bearer fixture-token" },
    });
  });
  it("does not accept another group's response or retry denied access", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ groupId: "other", workers: [] })))
      .mockResolvedValueOnce(new Response("", { status: 404 })); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPlanGroupStatus("expected")).rejects.toThrow("Invalid workstream status");
    await expect(fetchPlanGroupStatus("expected")).rejects.toThrow("Group unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    context.mockResolvedValue({ accessToken: null });
    await expect(fetchPlanGroupStatus("expected")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
