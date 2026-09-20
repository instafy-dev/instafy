import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHumanProfile } from "../humanProfileService";

const { resolveContext, readError } = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  readError: vi.fn(),
}));

vi.mock("../../services/runtimeController/core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: readError,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const context = { baseUrl: "https://controller.test", accessToken: "resolved-session-token" };
const params = { projectId: "space-1", userId: "person-1", accessToken: "supplied-session-token" };
const profile = {
  userId: params.userId,
  displayName: "Alex Reader",
  avatarUrl: "https://images.example.test/alex.png",
  bio: "I work on the editor.",
};

describe("human profile service", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue(context);
    readError.mockResolvedValue("You no longer share access to this space.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(profile))));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("encodes the exact project and target IDs and uses the resolved authenticated context", async () => {
    const encodedParams = { ...params, projectId: "space/one?", userId: "person/#&" };
    const expectedProfile = { ...profile, userId: encodedParams.userId };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(expectedProfile)));
    const abort = new AbortController();

    await expect(fetchHumanProfile({ ...encodedParams, signal: abort.signal })).resolves.toEqual(expectedProfile);

    expect(resolveContext).toHaveBeenCalledExactlyOnceWith(params.accessToken);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://controller.test/projects/space%2Fone%3F/members/person%2F%23%26/profile",
      {
        method: "GET",
        headers: { authorization: "Bearer resolved-session-token", accept: "application/json" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("preserves explicitly cleared values and exposes only the four public profile fields", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      userId: params.userId,
      displayName: null,
      avatarUrl: null,
      bio: null,
      email: "private@example.test",
      rawUserMetadata: { full_name: "Obsolete name", avatar_url: "https://images.example.test/old.png" },
      role: "owner",
    })));

    await expect(fetchHumanProfile(params)).resolves.toEqual({
      userId: params.userId,
      displayName: null,
      avatarUrl: null,
      bio: null,
    });
  });

  it("rejects denied access instead of returning an empty profile", async () => {
    const response = new Response("Forbidden", { status: 403 });
    const json = vi.spyOn(response, "json");
    vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(fetchHumanProfile(params)).rejects.toThrow("You no longer share access to this space.");

    expect(readError).toHaveBeenCalledExactlyOnceWith(response, "Unable to load this profile.", context);
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing fields", { userId: params.userId }],
    ["wrong user", { ...profile, userId: "another-person" }],
    ["non-string name", { ...profile, displayName: 17 }],
    ["non-string photo", { ...profile, avatarUrl: { url: profile.avatarUrl } }],
    ["non-string bio", { ...profile, bio: ["Introduction"] }],
  ])("rejects a malformed response: %s", async (_label, value) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(value)));

    await expect(fetchHumanProfile(params)).rejects.toThrow("Invalid profile response.");
  });

  it.each([
    { baseUrl: "https://controller.test", accessToken: null },
    { baseUrl: null, accessToken: "resolved-session-token" },
  ])("requires a complete authenticated controller context", async (invalidContext) => {
    resolveContext.mockResolvedValueOnce(invalidContext);

    await expect(fetchHumanProfile(params)).rejects.toThrow("Sign in to view this profile.");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fetch when canceled while authentication is still resolving", async () => {
    const pendingContext = deferred<typeof context>();
    resolveContext.mockReturnValueOnce(pendingContext.promise);
    const abort = new AbortController();
    const request = fetchHumanProfile({ ...params, signal: abort.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(resolveContext).toHaveBeenCalled());

    abort.abort();
    await rejected;
    pendingContext.resolve({ ...context, accessToken: "obsolete-account-token" });
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a late response body after cancellation and aborts the HTTP request signal", async () => {
    const body = deferred<typeof profile>();
    const json = vi.fn(() => body.promise);
    vi.mocked(fetch).mockResolvedValueOnce(Object.assign(new Response("{}"), { json }));
    const abort = new AbortController();
    const request = fetchHumanProfile({ ...params, signal: abort.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    const fetchSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;

    abort.abort();
    await rejected;
    expect(fetchSignal?.aborted).toBe(true);
    body.resolve(profile);

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
