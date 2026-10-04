import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestOriginAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/core", () => ({
  normalizeOriginEndpointForClient: (value: string) => value,
  runtimeControllerEnabled: true,
}));

vi.mock("../runtimeController/origins", () => ({
  requestOriginAccessToken: requestOriginAccessTokenMock,
}));

vi.mock("../runtimeController/workspaceApply", () => ({
  applyWorkspaceChangesViaOrigin: vi.fn(),
}));

import { instafyClientHeaderValue } from "../runtimeController/originRequest";
import {
  getWorkspaceFileRawUrl,
  listWorkspaceEntriesAt,
  listWorkspaceEntriesFromController,
  readWorkspaceFileAt,
  readWorkspaceFileFromController,
} from "../runtimeController/workspaceFiles";

function token(overrides: Record<string, unknown> = {}) {
  return {
    originId: "origin-1",
    endpoint: "http://runtime-origin.test",
    mode: "hosted",
    token: "origin-token",
    expiresIn: 60,
    scopes: ["fs.read"],
    leaseId: null,
    ...overrides,
  };
}

function fileResponse(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      path: "repos/instafy-dev-demo/TODO.md",
      size: 5,
      encoding: "base64",
      mimeType: "text/markdown",
      content_base64: "SGVsbG8=",
      ...body,
    }),
    { status: 200, headers: { "content-type": "application/json", ...headers } },
  );
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const legacyReadHeaders = () => ({
  authorization: "Bearer origin-token",
  accept: "application/json",
  "x-instafy-client": instafyClientHeaderValue(),
});

beforeEach(() => {
  requestOriginAccessTokenMock.mockReset();
  vi.restoreAllMocks();
  requestOriginAccessTokenMock.mockResolvedValue(token());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readWorkspaceFileFromController", () => {
  it("uses the read timeout when minting origin access for previews", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await readWorkspaceFileFromController({
      projectId: "project-1",
      path: "repos/instafy-dev-demo/TODO.md",
      runtimeId: null,
      timeoutMs: 5000,
    });

    expect(result?.contentText).toBe("Hello");
    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith({
      projectId: "project-1",
      protocol: "http",
      scopes: ["fs.read"],
      originId: null,
      preferRuntime: null,
      accessToken: null,
      timeoutMs: 5000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy request shape (runtime preference, URL, headers)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse());
    vi.stubGlobal("fetch", fetchMock);

    await readWorkspaceFileFromController({ projectId: "project-1", path: "src/a b.ts", runtimeId: "runtime-1" });

    expect(requestOriginAccessTokenMock.mock.calls[0][0]).toEqual({
      projectId: "project-1",
      protocol: "http",
      scopes: ["fs.read"],
      originId: null,
      preferRuntime: "runtime-1",
      accessToken: null,
      timeoutMs: undefined,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://runtime-origin.test/files/src/a%20b.ts?encoding=base64");
    expect(init.headers).toEqual(legacyReadHeaders());
    expect(init.cache).toBe("no-store");
  });

  it("captures the blob and rev headers and the origin that served the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fileResponse({ "x-instafy-blob": "ce01362", "x-instafy-rev": "rev-1" })),
    );
    const result = await readWorkspaceFileFromController({ projectId: "p", path: "TODO.md" });
    expect(result).toMatchObject({ blobOid: "ce01362", rev: "rev-1", originId: "origin-1", originMode: "hosted" });
  });

  it("falls back to blobOid in the body and leaves rev null without the header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fileResponse({}, { blobOid: "body-oid" })));
    const result = await readWorkspaceFileFromController({ projectId: "p", path: "TODO.md" });
    expect(result).toMatchObject({ blobOid: "body-oid", rev: null });
  });

  it("returns null on 404 and on errors, as before", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    expect(await readWorkspaceFileFromController({ projectId: "p", path: "x" })).toBeNull();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    expect(await readWorkspaceFileFromController({ projectId: "p", path: "x" })).toBeNull();
  });
});

describe("readWorkspaceFileAt", () => {
  it("default routing pins the origin, drops preferRuntime and pins rev", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse({ "x-instafy-rev": "a".repeat(40) }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await readWorkspaceFileAt({
      projectId: "p",
      path: "README.md",
      originId: "origin-1",
      runtimeId: "runtime-1",
      rev: "a".repeat(40),
      routing: "default",
    });
    expect(result?.ok).toBe(true);
    const mint = requestOriginAccessTokenMock.mock.calls[0][0];
    expect(mint).toMatchObject({ originId: "origin-1", scopes: ["fs.read"] });
    expect(mint).not.toHaveProperty("preferRuntime");
    expect(mint).not.toHaveProperty("preferHosted");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://runtime-origin.test/files/README.md?encoding=base64&rev=${"a".repeat(40)}`,
    );
  });

  it("reads at a recovery ref", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse());
    vi.stubGlobal("fetch", fetchMock);
    await readWorkspaceFileAt({ projectId: "p", path: "a.md", ref: "refs/instafy/recovery/o/n", routing: "default" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://runtime-origin.test/files/a.md?encoding=base64&ref=refs%2Finstafy%2Frecovery%2Fo%2Fn",
    );
  });

  it("refuses rev and ref together without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await readWorkspaceFileAt({ projectId: "p", path: "a.md", rev: "r", ref: "refs/instafy/salvage/gateway/x" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestOriginAccessTokenMock).not.toHaveBeenCalled();
  });

  it("maps 413 to too_large", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(413, { error: "too large", code: "too_large" })));
    const result = await readWorkspaceFileAt({ projectId: "p", path: "big.bin", routing: "default" });
    expect(result).toMatchObject({ ok: false, notFound: false, error: { status: 413, code: "too_large" } });
  });

  it("separates rev_not_found from a missing path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(404, { error: "unknown rev", code: "rev_not_found" })));
    expect(await readWorkspaceFileAt({ projectId: "p", path: "a", rev: "r", routing: "default" })).toMatchObject({
      ok: false,
      notFound: false,
      error: { code: "rev_not_found" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(404, { error: "not found", code: "not_found" })));
    expect(await readWorkspaceFileAt({ projectId: "p", path: "a", routing: "default" })).toMatchObject({
      ok: false,
      notFound: true,
    });
  });
});

describe("listWorkspaceEntriesFromController", () => {
  it("keeps the legacy runtime-first request shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, [{ name: "a.ts", path: "src/a.ts", kind: "file", size: 3 }]));
    vi.stubGlobal("fetch", fetchMock);

    const entries = await listWorkspaceEntriesFromController({
      projectId: "p",
      path: "/src/",
      runtimeId: "runtime-1",
      syncMode: "blocking",
    });

    expect(entries).toEqual([
      { name: "a.ts", path: "src/a.ts", kind: "file", size: 3, modified: null, mimeType: null, extension: "ts", hasChildren: undefined },
    ]);
    expect(requestOriginAccessTokenMock.mock.calls[0][0]).toEqual({
      projectId: "p",
      protocol: "http",
      scopes: ["fs.read"],
      originId: null,
      preferRuntime: "runtime-1",
      accessToken: null,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://runtime-origin.test/entries?path=src&sync=blocking");
    expect(init.headers).toEqual(legacyReadHeaders());
  });

  it("falls back to the default origin when the runtime listing fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 502 }))
      .mockResolvedValueOnce(json(200, []));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listWorkspaceEntriesFromController({ projectId: "p", runtimeId: "runtime-1" })).toEqual([]);
    expect(requestOriginAccessTokenMock.mock.calls.map((call) => call[0].preferRuntime)).toEqual(["runtime-1", null]);
  });

  it("treats 404 as an empty folder and errors as null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    expect(await listWorkspaceEntriesFromController({ projectId: "p" })).toEqual([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    expect(await listWorkspaceEntriesFromController({ projectId: "p" })).toBeNull();
  });

  it("parses blobOid in camelCase and snake_case", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(200, [
          { name: "a", path: "a", kind: "file", blobOid: "oid-a" },
          { name: "b", path: "b", kind: "file", blob_oid: "oid-b" },
          { name: "c", path: "c", kind: "directory" },
        ]),
      ),
    );
    const entries = await listWorkspaceEntriesFromController({ projectId: "p" });
    expect(entries?.map((entry) => entry.blobOid)).toEqual(["oid-a", "oid-b", undefined]);
    expect(entries?.[2]).not.toHaveProperty("blobOid");
  });
});

describe("listWorkspaceEntriesAt", () => {
  it("default routing pins the origin and the rev and reports X-Instafy-Rev", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, [], { "x-instafy-rev": "rev-2" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await listWorkspaceEntriesAt({
      projectId: "p",
      path: "docs",
      originId: "origin-1",
      runtimeId: "runtime-1",
      rev: "rev-2",
      routing: "default",
    });
    expect(result).toEqual({ ok: true, entries: [], rev: "rev-2", originId: "origin-1", originMode: "hosted" });
    expect(requestOriginAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(requestOriginAccessTokenMock.mock.calls[0][0]).not.toHaveProperty("preferRuntime");
    expect(fetchMock.mock.calls[0][0]).toBe("http://runtime-origin.test/entries?path=docs&rev=rev-2");
  });

  it("reports rev_not_found as an error so the caller can retry unpinned", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(404, { error: "unknown rev", code: "rev_not_found" })));
    const result = await listWorkspaceEntriesAt({ projectId: "p", rev: "gone", routing: "default" });
    expect(result).toMatchObject({ ok: false, error: { status: 404, code: "rev_not_found" } });
  });

  it("refuses rev and ref together", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await listWorkspaceEntriesAt({ projectId: "p", rev: "r", ref: "x" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getWorkspaceFileRawUrl", () => {
  it("keeps the legacy URL and adds rev or ref when given", async () => {
    expect(await getWorkspaceFileRawUrl({ projectId: "p", path: "img/a.png" })).toBe(
      "http://runtime-origin.test/raw/img/a.png?token=origin-token",
    );
    expect(await getWorkspaceFileRawUrl({ projectId: "p", path: "a.png", rev: "r1", routing: "default" })).toBe(
      "http://runtime-origin.test/raw/a.png?token=origin-token&rev=r1",
    );
    expect(await getWorkspaceFileRawUrl({ projectId: "p", path: "a.png", rev: "r1", ref: "x" })).toBeNull();
  });
});
