import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());

vi.mock("../core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core")>();
  return {
    ControllerApiError: actual.ControllerApiError,
    readControllerApiError: async (response: Response, fallback: string) => ({
      status: response.status, message: `${fallback} (${response.status})`, code: null, details: null,
    }),
    resolveControllerRequestContext: resolveControllerRequestContextMock,
    runtimeControllerEnabled: true,
  };
});

import { ControllerApiError } from "../core";
import {
  createSitePreviewViewer,
  getSitePreview,
  heartbeatSitePreviewViewer,
  isSitePreviewsUnavailable,
  revokeSitePreviewViewer,
  sitePreviewRecordState,
} from "../previews";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost/";
const BASE = `http://controller.test/projects/${PROJECT_ID}/previews/${PREVIEW_ID}`;

describe("site preview controller client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resolveControllerRequestContextMock.mockResolvedValue({ baseUrl: "http://controller.test", accessToken: "token-123", credentialSource: "ambient", generation: 1 });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads a preview with its health and no address", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ previewId: PREVIEW_ID, title: "Docs site", port: 4173, path: "/",
      runtimeId: "runtime-1", status: "ACTIVE", health: { listening: false, status: null }, messageId: "m-1", createdAt: "2026-10-12T00:00:00Z",
      viewerUrl: VIEWER })));
    const preview = await getSitePreview(PROJECT_ID, PREVIEW_ID);
    expect(preview).toEqual({ previewId: PREVIEW_ID, title: "Docs site", port: 4173, path: "/",
      runtimeId: "runtime-1", status: "active", health: { listening: false, status: null }, messageId: "m-1", createdAt: "2026-10-12T00:00:00Z" });
    expect(JSON.stringify(preview)).not.toContain("p-aaaa");
    expect(fetchMock).toHaveBeenCalledWith(BASE, expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer token-123" }) }));
    await getSitePreview(PROJECT_ID, PREVIEW_ID, undefined, { fresh: true });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}?fresh=1`, expect.anything());
  });

  it("decides live, not responding and stopped from the record alone", () => {
    expect(sitePreviewRecordState({ status: "active", health: { listening: true, status: 200 } })).toBe("live");
    expect(sitePreviewRecordState({ status: "active", health: null })).toBe("live");
    expect(sitePreviewRecordState({ status: "active", health: { listening: false, status: null } })).toBe("not_responding");
    expect(sitePreviewRecordState({ status: "active", health: { listening: true, status: 502 } })).toBe("not_responding");
    expect(sitePreviewRecordState({ status: "revoked", health: { listening: true, status: 200 } })).toBe("stopped");
  });

  it("keeps the HTTP status on failures and reads 404 and 503 as previews being unavailable", async () => {
    for (const status of [404, 503]) {
      fetchMock.mockResolvedValueOnce(new Response("{}", { status }));
      const error = await createSitePreviewViewer(PROJECT_ID, PREVIEW_ID).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ControllerApiError);
      expect(isSitePreviewsUnavailable(error)).toBe(true);
    }
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect(isSitePreviewsUnavailable(await createSitePreviewViewer(PROJECT_ID, PREVIEW_ID).catch((cause: unknown) => cause))).toBe(false);
  });

  it("mints a viewer for the pane, and a separate one for a new tab", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: "2026-10-12T12:00:00Z" })));
    await expect(createSitePreviewViewer(PROJECT_ID, PREVIEW_ID)).resolves.toEqual({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: "2026-10-12T12:00:00Z" });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/view`, expect.objectContaining({ method: "POST", body: "{}" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ viewerUrl: VIEWER })));
    await createSitePreviewViewer(PROJECT_ID, PREVIEW_ID, { tab: true });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/view?tab=true`, expect.objectContaining({ method: "POST" }));
  });

  it.each([
    ["a script address", "javascript:alert(1)"],
    // A host smuggled in as user info makes the real host attacker.example.
    ["user info", "http://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost:8083@attacker.example/x"],
    ["another preview", "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--0123456789abcdef0123456789abcdef.preview.localhost/"],
    ["a plain host", "https://attacker.example/"],
    ["a bare capability host", "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111/"],
    ["a short label", "https://p-aaaa--11111111111141118111111111111111.preview.localhost/"],
  ])("refuses a viewer address with %s", async (_name, viewerUrl) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ viewerUrl })));
    await expect(createSitePreviewViewer(PROJECT_ID, PREVIEW_ID)).rejects.toThrow("unusable");
  });

  it("sends the heartbeat with the capability and reads 410 as a dead session", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(heartbeatSitePreviewViewer(PROJECT_ID, PREVIEW_ID, VIEWER)).resolves.toBe("live");
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/view/heartbeat`, expect.objectContaining({ method: "POST", body: JSON.stringify({ viewerUrl: VIEWER }) }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));
    await expect(heartbeatSitePreviewViewer(PROJECT_ID, PREVIEW_ID, VIEWER)).resolves.toBe("gone");
    // Anything else is a passing failure, not a dead session.
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(heartbeatSitePreviewViewer(PROJECT_ID, PREVIEW_ID, VIEWER)).rejects.toMatchObject({ status: 503 });
  });

  it("revokes a viewer with an empty response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await revokeSitePreviewViewer(PROJECT_ID, PREVIEW_ID, VIEWER);
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/view/revoke`, expect.objectContaining({ method: "POST", body: JSON.stringify({ viewerUrl: VIEWER }) }));
  });
});
