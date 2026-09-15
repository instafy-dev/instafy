import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerMessageSearchError, searchControllerMessages } from "../messageSearch";

const { resolveContext, readError } = vi.hoisted(() => ({ resolveContext: vi.fn(), readError: vi.fn() }));
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: readError,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const page = { matches: [{ messageId: "message-1", conversationId: "chat-1", projectId: "space-1", orgId: "team-1", projectName: "Core", orgName: "Team", conversationTitle: "Search", role: "user", createdAt: "2026-09-10T10:00:00Z", snippet: "Find <search>", matchRanges: [{ start: 6, end: 12 }] }], hasMore: false, nextCursor: null };

describe("controller message search", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue({ baseUrl: "https://controller.test", accessToken: "test-token" });
    readError.mockResolvedValue("Message search access changed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { status: 200 })));
  });
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

  it("uses the authenticated controller context and encodes the selected scope and cursor", async () => {
    const abort = new AbortController();
    expect(await searchControllerMessages({ query: " search & fix ", projectId: "space-1", orgId: "team-1", cursor: "next/page", limit: 30, signal: abort.signal })).toEqual(page);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/search/messages");
    expect(new URL(String(url)).searchParams.get("q")).toBe("search & fix");
    expect(new URL(String(url)).searchParams.get("projectId")).toBe("space-1");
    expect(new URL(String(url)).searchParams.get("orgId")).toBe("team-1");
    expect(new URL(String(url)).searchParams.get("cursor")).toBe("next/page");
    expect(init?.headers).toEqual({ authorization: "Bearer test-token", accept: "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports unsupported controllers and forbidden scopes explicitly", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(searchControllerMessages({ query: "search" })).rejects.toMatchObject({ status: 404, message: "Message search is not available on this controller yet." });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(searchControllerMessages({ query: "search" })).rejects.toBeInstanceOf(ControllerMessageSearchError);
    expect(readError).toHaveBeenCalledOnce();
  });

  it("rejects malformed results instead of presenting them as an empty successful search", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...page, matches: [{ ...page.matches[0], matchRanges: [{ start: 0, end: 1000 }] }] }), { status: 200 }));
    await expect(searchControllerMessages({ query: "search" })).rejects.toThrow("Invalid message search response");
  });

  it("does not send a request if canceled while credentials are resolving", async () => {
    const context = deferred<{ baseUrl: string; accessToken: string }>();
    resolveContext.mockReturnValueOnce(context.promise);
    const abort = new AbortController();
    const request = searchControllerMessages({ query: "search", signal: abort.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await rejected;
    context.resolve({ baseUrl: "https://controller.test", accessToken: "obsolete-account-token" });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a late response body after cancellation", async () => {
    const body = deferred<typeof page>();
    const json = vi.fn(() => body.promise);
    vi.mocked(fetch).mockResolvedValueOnce(Object.assign(new Response("{}"), { json }));
    const abort = new AbortController();
    const request = searchControllerMessages({ query: "search", signal: abort.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    abort.abort();
    await rejected;
    body.resolve(page);
  });

  it("requires a valid query and a signed-in session", async () => {
    await expect(searchControllerMessages({ query: "a" })).rejects.toThrow("between 2 and 200");
    await expect(searchControllerMessages({ query: "a".repeat(201) })).rejects.toThrow("between 2 and 200");
    resolveContext.mockResolvedValueOnce({ baseUrl: "https://controller.test", accessToken: null });
    await expect(searchControllerMessages({ query: "search" })).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses Unicode character bounds consistently with the controller", async () => {
    await expect(searchControllerMessages({ query: "😀" })).rejects.toThrow("between 2 and 200");
    expect(fetch).not.toHaveBeenCalled();
    await expect(searchControllerMessages({ query: "😀".repeat(200) })).resolves.toEqual(page);
  });
});
