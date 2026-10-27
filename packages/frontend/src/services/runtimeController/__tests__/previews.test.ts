import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());
const controller = vi.hoisted(() => ({ enabled: true }));

vi.mock("../core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core")>();
  return {
    ControllerApiError: actual.ControllerApiError,
    readControllerApiError: async (response: Response, fallback: string) => {
      const body = await response.text().then(text => JSON.parse(text) as { code?: string }).catch(() => ({} as { code?: string }));
      return { status: response.status, message: `${fallback} (${response.status})`, code: body.code ?? null, details: null };
    },
    resolveControllerRequestContext: resolveControllerRequestContextMock,
    get runtimeControllerEnabled() { return controller.enabled; },
  };
});

import { ControllerApiError } from "../core";
import {
  createSitePreviewViewer,
  getSitePreview,
  getSitePreviewThumbnail,
  heartbeatSitePreviewViewer,
  mapSitePreviewThumbnailEvent,
  sitePreviewFacts,
  isSitePreviewsUnavailable,
  mapControllerSitePreview,
  revokeSitePreviewViewer,
  sitePreviewProblem,
  sitePreviewRecordState,
  wakeSitePreview,
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
  afterEach(() => { vi.unstubAllGlobals(); controller.enabled = true; });

  it("reads a Studio with no controller as one with no previews, and asks nothing", async () => {
    controller.enabled = false;
    const cause = await createSitePreviewViewer(PROJECT_ID, PREVIEW_ID).catch((error: unknown) => error);
    expect(sitePreviewProblem(cause)).toBe("unavailable");
    await expect(getSitePreview(PROJECT_ID, PREVIEW_ID).catch((error: unknown) => sitePreviewProblem(error))).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a preview with its health and no address", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ previewId: PREVIEW_ID, title: "Docs site", port: 4173, path: "/",
      runtimeId: "runtime-1", status: "ACTIVE", health: { listening: false, status: null }, messageId: "m-1", createdAt: "2026-10-12T00:00:00Z",
      visibility: "private", viewerUrl: VIEWER })));
    const preview = await getSitePreview(PROJECT_ID, PREVIEW_ID);
    expect(preview).toEqual({ previewId: PREVIEW_ID, title: "Docs site", port: 4173, path: "/",
      runtimeId: "runtime-1", status: "active", health: { listening: false, status: null }, messageId: "m-1", createdAt: "2026-10-12T00:00:00Z",
      visibility: "private", restartable: false, wake: { state: "idle", startedAt: null, error: null }, canStart: null,
      summary: null, pageDescription: null, thumbnail: null });
    expect(JSON.stringify(preview)).not.toContain("p-aaaa");
    expect(fetchMock).toHaveBeenCalledWith(BASE, expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer token-123" }) }));
    await getSitePreview(PROJECT_ID, PREVIEW_ID, undefined, { fresh: true });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}?fresh=1`, expect.anything());
  });

  it("decides live, not responding and stopped from the record alone", () => {
    expect(sitePreviewRecordState({ status: "active", health: { listening: true, status: 200 } })).toBe("live");
    // Live needs proof: no probe, or a tunnel not active yet, is never Live.
    expect(sitePreviewRecordState({ status: "active", health: null })).toBe("unverified");
    expect(sitePreviewRecordState({ status: "issuing", health: { listening: true, status: 200 } })).toBe("pending");
    expect(sitePreviewRecordState({ status: "active", health: { listening: false, status: null } })).toBe("not_responding");
    expect(sitePreviewRecordState({ status: "active", health: { listening: true, status: 502 } })).toBe("not_responding");
    expect(sitePreviewRecordState({ status: "revoked", health: { listening: true, status: 200 } })).toBe("stopped");
  });

  it.each([
    ["503 previews_unavailable", 503, JSON.stringify({ message: "Previews are not available on this server", code: "previews_unavailable" }), "unavailable"],
    // An older controller has no preview routes: its 404 has no body.
    ["a bodiless 404", 404, "", "unavailable"],
    ["the controller's 404 for a preview that does not exist", 404, JSON.stringify({ message: "preview not found" }), "missing"],
    ["403", 403, JSON.stringify({ message: "forbidden" }), "no_access"],
    ["409", 409, JSON.stringify({ message: "this preview has stopped" }), "stopped"],
    ["a passing 503", 503, "", null],
    ["a 500", 500, JSON.stringify({ message: "boom" }), null],
  ])("keeps the HTTP status on failures and reads %s as %s", async (_name, status, body, problem) => {
    fetchMock.mockResolvedValueOnce(new Response(body || null, { status: status as number }));
    const error = await createSitePreviewViewer(PROJECT_ID, PREVIEW_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ControllerApiError);
    expect((error as ControllerApiError).status).toBe(status);
    expect(sitePreviewProblem(error)).toBe(problem);
    expect(isSitePreviewsUnavailable(error)).toBe(problem === "unavailable");
  });

  it("reads a network failure as passing", () => {
    expect(sitePreviewProblem(new TypeError("Failed to fetch"))).toBeNull();
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
    // Plain http only on a local stack.
    ["plain http off a local stack", "http://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.example.com/"],
  ])("refuses a viewer address with %s", async (_name, viewerUrl) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ viewerUrl })));
    await expect(createSitePreviewViewer(PROJECT_ID, PREVIEW_ID)).rejects.toThrow("unusable");
  });

  it.each([
    "http://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost:8083/",
    "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.example.com/",
  ])("accepts %s", async (viewerUrl) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ viewerUrl })));
    await expect(createSitePreviewViewer(PROJECT_ID, PREVIEW_ID)).resolves.toMatchObject({ viewerUrl });
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
    expect(fetchMock.mock.lastCall?.[1]).not.toHaveProperty("keepalive");
  });

  it("sends a revoke that can outlive the page when asked to", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await revokeSitePreviewViewer(PROJECT_ID, PREVIEW_ID, VIEWER, { keepalive: true });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/view/revoke`, expect.objectContaining({
      method: "POST", keepalive: true, body: JSON.stringify({ viewerUrl: VIEWER }),
      headers: expect.objectContaining({ authorization: "Bearer token-123" }),
    }));
  });

  it("reads whether a preview can be woken without Octo, and its wake", () => {
    const base = { previewId: PREVIEW_ID, port: 4173, status: "revoked" };
    expect(mapControllerSitePreview({ ...base, restartable: true, wake: { state: "WAKING", startedAt: "2026-10-14T10:00:00Z" } }))
      .toMatchObject({ restartable: true, wake: { state: "waking", startedAt: "2026-10-14T10:00:00Z", error: null } });
    // Shown as one plain line on the card: whitespace folded, length capped.
    const failed = mapControllerSitePreview({ ...base, restartable: true, wake: { state: "failed", error: `port\n4173 ${"x".repeat(400)}` } })!;
    expect(failed.wake?.state).toBe("failed");
    expect(failed.wake!.error!.startsWith("port 4173 x")).toBe(true);
    expect(failed.wake!.error!.length).toBe(160);
    // Anything else (an older controller, a made-up state) is idle and not restartable.
    expect(mapControllerSitePreview({ ...base, restartable: "yes", wake: { state: "exploding" } }))
      .toMatchObject({ restartable: false, wake: { state: "idle", startedAt: null, error: null } });
    expect(mapControllerSitePreview(base)).toMatchObject({ restartable: false, wake: { state: "idle" } });
    // Whether Open may start it for this person: only a boolean the controller sent counts.
    expect(mapControllerSitePreview({ ...base, canStart: false })?.canStart).toBe(false);
    expect(mapControllerSitePreview({ ...base, canStart: true })?.canStart).toBe(true);
    expect(mapControllerSitePreview({ ...base, canStart: "no" })?.canStart).toBeNull();
  });

  it("wakes a preview with an empty POST and reads live or waking", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ state: "live" })));
    await expect(wakeSitePreview(PROJECT_ID, PREVIEW_ID)).resolves.toEqual({ state: "live" });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/wake`,
      expect.objectContaining({ method: "POST", body: "{}", headers: expect.objectContaining({ authorization: "Bearer token-123" }) }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ state: "waking" }), { status: 202 }));
    await expect(wakeSitePreview(PROJECT_ID, PREVIEW_ID)).resolves.toEqual({ state: "waking" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const error = await wakeSitePreview(PROJECT_ID, PREVIEW_ID).catch((cause: unknown) => cause);
    expect((error as ControllerApiError).status).toBe(429);
  });

  it("reads the card's facts and picture, as plain text and a version, never an address", () => {
    const base = { previewId: PREVIEW_ID, title: "Lisbon weekend", port: 4173, path: "/", status: "active" };
    const preview = mapControllerSitePreview({
      ...base,
      summary: "  Trip ·\n 3 days · 14 places ",
      pageDescription: "A map of \u202Eevil\u202C Lisbon",
      thumbnail: { version: "0123456789abcdef", width: 640, height: 400, capturedAt: "2026-10-27T12:00:00Z", url: "https://elsewhere.test/x.png" },
    })!;
    expect(preview.summary).toBe("Trip · 3 days · 14 places");
    expect(preview.pageDescription).toBe("A map of evil Lisbon");
    expect(preview.thumbnail).toEqual({ version: "0123456789abcdef", width: 640, height: 400, capturedAt: "2026-10-27T12:00:00Z" });
    expect(sitePreviewFacts(preview)).toBe("Trip · 3 days · 14 places");
    expect(sitePreviewFacts({ summary: null, pageDescription: "x".repeat(120) })).toBe(`${"x".repeat(79)}…`);
    expect(sitePreviewFacts({ summary: null, pageDescription: null })).toBeNull();
    for (const thumbnail of [{ version: "../../x", width: 640, height: 400 }, { version: "0123456789abcdef", width: 0, height: 400 }, "picture.png"]) {
      expect(mapControllerSitePreview({ ...base, thumbnail })?.thumbnail).toBeNull();
    }
    expect(mapSitePreviewThumbnailEvent({ previewId: PREVIEW_ID, version: "0123456789abcdef", runtimeId: "r" })).toEqual({ previewId: PREVIEW_ID, version: "0123456789abcdef" });
    expect(mapSitePreviewThumbnailEvent({ previewId: PREVIEW_ID, version: "javascript:alert(1)" })).toBeNull();
  });

  it("fetches a preview's picture with the person's session, never caching it on disk, and reads refusals", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["jpeg"]), { headers: { "content-type": "image/jpeg" } }));
    const picture = await getSitePreviewThumbnail(PROJECT_ID, PREVIEW_ID, "0123456789abcdef");
    expect(picture.ok).toBe(true);
    expect(picture.ok && picture.blob.type).toBe("image/jpeg");
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/thumbnail?v=0123456789abcdef`, expect.objectContaining({
      cache: "no-store", credentials: "omit", headers: expect.objectContaining({ authorization: "Bearer token-123" }),
    }));
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(getSitePreviewThumbnail(PROJECT_ID, PREVIEW_ID, "0123456789abcdef")).resolves.toEqual({ ok: false, reason: "refused" });
    fetchMock.mockResolvedValueOnce(new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
    await expect(getSitePreviewThumbnail(PROJECT_ID, PREVIEW_ID, "0123456789abcdef")).resolves.toEqual({ ok: false, reason: "refused" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
    await expect(getSitePreviewThumbnail(PROJECT_ID, PREVIEW_ID, "0123456789abcdef")).resolves.toEqual({ ok: false, reason: "transient" });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(getSitePreviewThumbnail(PROJECT_ID, PREVIEW_ID, "0123456789abcdef")).resolves.toEqual({ ok: false, reason: "transient" });
  });
});
