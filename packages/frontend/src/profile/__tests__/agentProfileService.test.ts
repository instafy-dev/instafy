import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicAgentProfile } from "../../services/runtimeController/agents";

const { resolveContext, readError } = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  readError: vi.fn(),
}));

vi.mock("../../services/runtimeController/core", () => ({
  runtimeControllerEnabled: true,
  controllerBaseUrl: "https://unused-default.test",
  resolveControllerRequestContext: resolveContext,
  readControllerError: readError,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const context = { baseUrl: "https://controller.test", accessToken: "resolved-controller-token" };
const projectId = "space-1";
const agentId = "agent-1";
const profile = {
  id: agentId,
  handle: "octo",
  displayName: "Octo",
  avatarSeed: "octo-seed",
  bio: "I help with the editor.",
};

describe("public agent profile service", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue(context);
    readError.mockResolvedValue("You no longer have access to this agent in this space.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(profile))));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the public profile using the resolved controller context and caller authentication", async () => {
    const abort = new AbortController();
    await expect(getPublicAgentProfile(projectId, agentId, { accessToken: "supplied-session-token", signal: abort.signal }))
      .resolves.toEqual({ success: true, value: profile });

    expect(resolveContext).toHaveBeenCalledExactlyOnceWith("supplied-session-token");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).origin).toBe(context.baseUrl);
    expect(init).toEqual({
      method: "GET",
      headers: { authorization: "Bearer resolved-controller-token", accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves cleared public values and excludes instructions, credentials and ownership data", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ...profile, displayName: null, bio: null,
      description: "Private instructions that must not appear on a public card.",
      credentialId: "credential-private",
      credential: { apiKey: "inert-test-credential" },
      ownerUserId: "private-owner-id",
      provider: "openai",
      model: "private-model-setting",
    })));

    await expect(getPublicAgentProfile(projectId, agentId)).resolves.toEqual({
      success: true,
      value: { id: agentId, handle: "octo", displayName: null, avatarSeed: "octo-seed", bio: null },
    });
    expect(resolveContext).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("reports denied access as failure without decoding a successful profile", async () => {
    const response = new Response("Forbidden", { status: 403 });
    const json = vi.spyOn(response, "json");
    vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(getPublicAgentProfile(projectId, agentId)).resolves.toEqual({
      success: false, error: "You no longer have access to this agent in this space.",
    });
    expect(readError).toHaveBeenCalledExactlyOnceWith(response, "Unable to load agent profile.", context);
    expect(json).not.toHaveBeenCalled();
  });

  it("reports transport failure without returning a stale or empty successful profile", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network connection was interrupted."));

    await expect(getPublicAgentProfile(projectId, agentId)).resolves.toEqual({
      success: false, error: "Network connection was interrupted.",
    });
    expect(readError).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing fields", { id: agentId }],
    ["wrong agent", { ...profile, id: "another-agent" }],
    ["non-string handle", { ...profile, handle: 42 }],
    ["non-string avatar seed", { ...profile, avatarSeed: null }],
    ["non-string display name", { ...profile, displayName: { value: "Octo" } }],
    ["non-string bio", { ...profile, bio: ["Introduction"] }],
  ])("rejects a malformed or mismatched public profile: %s", async (_label, value) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(value)));

    await expect(getPublicAgentProfile(projectId, agentId)).resolves.toEqual({
      success: false, error: "Invalid agent profile response.",
    });
  });

  it.each([
    { baseUrl: "https://controller.test", accessToken: null },
    { baseUrl: null, accessToken: "resolved-controller-token" },
  ])("does not fetch without a complete authenticated controller context", async (invalidContext) => {
    resolveContext.mockResolvedValueOnce(invalidContext);

    await expect(getPublicAgentProfile(projectId, agentId)).resolves.toEqual({
      success: false, error: "Sign in to view this profile.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels authentication waiting and never sends a request with late credentials", async () => {
    const pendingContext = deferred<typeof context>();
    resolveContext.mockReturnValueOnce(pendingContext.promise);
    const abort = new AbortController();
    const request = getPublicAgentProfile(projectId, agentId, { signal: abort.signal });
    await vi.waitFor(() => expect(resolveContext).toHaveBeenCalled());

    abort.abort();
    expect(await request).toMatchObject({ success: false });
    pendingContext.resolve({ ...context, accessToken: "obsolete-account-token" });
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels the HTTP signal and ignores response data that arrives after closing", async () => {
    const body = deferred<typeof profile>();
    const json = vi.fn(() => body.promise);
    vi.mocked(fetch).mockResolvedValueOnce(Object.assign(new Response("{}"), { json }));
    const abort = new AbortController();
    const request = getPublicAgentProfile(projectId, agentId, { signal: abort.signal });
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    const requestSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;

    abort.abort();
    const result = await request;
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("value");
    expect(requestSignal?.aborted).toBe(true);
    body.resolve(profile);

    await expect(request).resolves.toBe(result);
  });
});
