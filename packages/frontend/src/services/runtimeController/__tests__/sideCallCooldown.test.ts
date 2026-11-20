import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessTokenMock = vi.hoisted(() => vi.fn<() => string | null>());

vi.mock("../projectNotFound", () => ({ reportControllerProjectNotFound: vi.fn() }));

vi.mock("../core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core")>()),
  resolveControllerRequestContext: async () => ({
    baseUrl: "http://controller.test",
    accessToken: accessTokenMock(),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
}));

import { requestProjectEditorInlineCompletion } from "../completions";
import { requestProjectConversationTitle } from "../conversations";
import { resetSideCallCooldownsForTests } from "../sideCallCooldown";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const PERSON = jwt({ sub: "624ae065-1cfe-4a2b-9c3d-0123456789ab" });
const TEAMMATE = jwt({ sub: "7f3e2d1c-0b9a-4876-a543-210fedcba987" });

/** The body the controller sends when a side call is over its limit. */
function refusal(code: string, details: Record<string, unknown> | null): Response {
  return new Response(
    JSON.stringify({ message: "Too many inline completions. Try again in 30 seconds.", code, details }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function completionRefused(retryAfterSeconds: number): Response {
  return refusal("editor_completion_rate_limited", {
    retryable: true,
    retryAfterSeconds,
    limit: 600,
    windowSeconds: 60,
  });
}

function titleRefused(retryAfterSeconds: number): Response {
  return refusal("conversation_title_rate_limited", {
    retryable: true,
    retryAfterSeconds,
    limit: 200,
    windowSeconds: 3_600,
  });
}

const completed = () => new Response(JSON.stringify({ completion: " = 1;", provider: "openai" }));
const titled = () => new Response(JSON.stringify({ title: "Quarterly report", provider: "openai" }));

const askCompletion = () =>
  requestProjectEditorInlineCompletion({
    projectId: "project-1",
    path: "src/a.ts",
    prefix: "const a",
    suffix: "",
  });
const askTitle = () =>
  requestProjectConversationTitle({ projectId: "project-1", message: "Write the quarterly report" });

describe("side calls refused by the per-account limits", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    resetSideCallCooldownsForTests();
    accessTokenMock.mockReset();
    accessTokenMock.mockReturnValue(PERSON);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("show no completion and wait out retryAfterSeconds before asking again", async () => {
    fetchMock.mockResolvedValueOnce(completionRefused(30)).mockImplementation(async () => completed());

    await expect(askCompletion()).resolves.toMatchObject({ success: false, completion: null });
    vi.advanceTimersByTime(29_999);
    await expect(askCompletion()).resolves.toMatchObject({
      success: false,
      completion: null,
      error: "Too many inline completions. Try again in 30 seconds.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(askCompletion()).resolves.toMatchObject({ success: true, completion: " = 1;" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leave the title to its fallback and pause titles only", async () => {
    fetchMock
      .mockResolvedValueOnce(titleRefused(1_200))
      .mockResolvedValueOnce(completed())
      .mockImplementation(async () => titled());

    await expect(askTitle()).resolves.toMatchObject({ success: false, title: null });
    await expect(askTitle()).resolves.toMatchObject({ success: false, title: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Completions are counted apart, so a title refusal does not stop them.
    await expect(askCompletion()).resolves.toMatchObject({ success: true, completion: " = 1;" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("http://controller.test/projects/project-1/editor/completions");

    vi.advanceTimersByTime(1_200_000);
    await expect(askTitle()).resolves.toMatchObject({ success: true, title: "Quarterly report" });
    expect(fetchMock.mock.calls[2][0]).toBe("http://controller.test/projects/project-1/conversation/title");
  });

  it("ask again when the clock moved back further than the hour window", async () => {
    fetchMock.mockResolvedValueOnce(completionRefused(60)).mockImplementation(async () => completed());

    await askCompletion();
    vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
    await expect(askCompletion()).resolves.toMatchObject({ success: true, completion: " = 1;" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keep a full hour's wait, and drop it once the clock steps back past it", async () => {
    fetchMock.mockResolvedValueOnce(titleRefused(3_600)).mockImplementation(async () => titled());

    await askTitle();
    await expect(askTitle()).resolves.toMatchObject({ success: false, title: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() - 1);
    await expect(askTitle()).resolves.toMatchObject({ success: true, title: "Quarterly report" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pause only the person who was refused", async () => {
    fetchMock.mockResolvedValueOnce(completionRefused(30)).mockImplementation(async () => completed());

    await askCompletion();
    accessTokenMock.mockReturnValue(TEAMMATE);
    await expect(askCompletion()).resolves.toMatchObject({ success: true, completion: " = 1;" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe(`Bearer ${TEAMMATE}`);
  });

  it.each([
    ["a server error", () => new Response("boom", { status: 500 })],
    ["another limit's refusal", () => refusal("credential_test_rate_limited", { retryAfterSeconds: 30 })],
    ["a refusal of the other kind of side call", () => titleRefused(30)],
  ])("ask again at the next pause after %s", async (_label, failure) => {
    fetchMock.mockResolvedValueOnce(failure()).mockImplementation(async () => completed());

    await expect(askCompletion()).resolves.toMatchObject({ success: false, completion: null });
    await expect(askCompletion()).resolves.toMatchObject({ success: true, completion: " = 1;" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no details", null, 60_000],
    ["no wait", { retryable: true, limit: 600, windowSeconds: 60 }, 60_000],
    ["an unusable wait", { retryAfterSeconds: "soon" }, 60_000],
    ["a fractional wait", { retryAfterSeconds: 2.2 }, 3_000],
    ["a wait longer than the hour window", { retryAfterSeconds: 86_400 }, 3_600_000],
  ])("wait the right time for a refusal with %s", async (_label, details, waitMs) => {
    fetchMock
      .mockResolvedValueOnce(refusal("editor_completion_rate_limited", details))
      .mockImplementation(async () => completed());

    await askCompletion();
    vi.advanceTimersByTime(waitMs - 1);
    await expect(askCompletion()).resolves.toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(askCompletion()).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
