import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestOriginAccessTokenMock } = vi.hoisted(() => ({
  requestOriginAccessTokenMock: vi.fn(),
}));

vi.mock("../runtimeController/origins", () => ({
  requestOriginAccessToken: requestOriginAccessTokenMock,
}));

import {
  BrowserSessionPageCaptureError,
  captureRuntimeBrowserSessionPage,
  mapRuntimeBrowserSessionPageCapturePayload,
} from "../runtimeController/browserSession";

const READ_AT = "2026-10-26T09:30:00.000Z";
const capture = {
  pageId: "page-1",
  url: "https://shop.example/orders/42",
  title: "Order 42",
  text: "Ships Monday. Hook: [redacted secret]",
  secretScreen: false,
  truncated: false,
  readAt: READ_AT,
};

beforeEach(() => {
  requestOriginAccessTokenMock.mockReset();
  requestOriginAccessTokenMock.mockImplementation(async ({ scopes }: { scopes: string[] }) => ({
    originId: "origin-1",
    endpoint: "https://origin.example.test/",
    mode: "hosted",
    token: "origin-token",
    expiresIn: 60,
    scopes,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("captureRuntimeBrowserSessionPage", () => {
  it("asks the workspace browser for one masked read with a control grant", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(capture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      captureRuntimeBrowserSessionPage({
        projectId: "project-1",
        browserSessionId: "surface-1",
        pageId: "page-1",
        preferRuntimeId: "runtime-1",
      }),
    ).resolves.toEqual(capture);

    expect(requestOriginAccessTokenMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: "project-1",
        scopes: ["browser.control"],
        browserSessionId: "surface-1",
        preferRuntime: "runtime-1",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://origin.example.test/browser/pages/page-1/capture");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer origin-token");
  });

  it("tells the origin's own refusals apart and never shows its error text", async () => {
    const answers: Array<[number, unknown, string | null]> = [
      [409, { error: "this tab has no web page to send" }, "not_web_page"],
      [409, { error: "the page changed while it was being read; try again" }, "changed"],
      [409, { error: "something else" }, null],
      [404, { error: "sending a page is not available on this runtime" }, null],
      [503, { error: `browser cdp rejected Runtime.evaluate: ${"secret page text"}` }, null],
    ];
    for (const [status, body, reason] of answers) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
      const error = await captureRuntimeBrowserSessionPage({
        projectId: "project-1",
        browserSessionId: "surface-1",
        pageId: "page-1",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BrowserSessionPageCaptureError);
      expect((error as BrowserSessionPageCaptureError).status).toBe(status);
      expect((error as BrowserSessionPageCaptureError).reason).toBe(reason);
      expect((error as Error).message).not.toContain("secret page text");
    }
  });

  it("refuses a grant it could not get", async () => {
    requestOriginAccessTokenMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      captureRuntimeBrowserSessionPage({ projectId: "project-1", browserSessionId: "surface-1", pageId: "page-1" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mapRuntimeBrowserSessionPageCapturePayload", () => {
  it("keeps only a well-formed answer for the page that was asked for", () => {
    expect(mapRuntimeBrowserSessionPageCapturePayload(capture, "page-1")).toEqual(capture);
    expect(mapRuntimeBrowserSessionPageCapturePayload(capture, "page-2")).toBeNull();
    expect(mapRuntimeBrowserSessionPageCapturePayload({ ...capture, readAt: "yesterday" }, "page-1")).toBeNull();
    expect(mapRuntimeBrowserSessionPageCapturePayload({ ...capture, text: "x".repeat(50_001) }, "page-1")).toBeNull();
    expect(mapRuntimeBrowserSessionPageCapturePayload({ ...capture, secretScreen: "no" }, "page-1")).toBeNull();
    expect(mapRuntimeBrowserSessionPageCapturePayload(null, "page-1")).toBeNull();
  });

  it("drops any text that comes with a withheld page", () => {
    expect(
      mapRuntimeBrowserSessionPageCapturePayload({ ...capture, secretScreen: true }, "page-1"),
    ).toMatchObject({ secretScreen: true, title: "", text: "" });
  });
});
