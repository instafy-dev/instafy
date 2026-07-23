import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decideRuntimeSharedBrowserApproval,
  fetchRuntimeSharedBrowserPendingApproval,
  mapRuntimeSharedBrowserPendingApprovalPayload,
} from "../runtimeController/browserApproval";

const pendingApprovalPayload = {
  pending: {
    runtimeId: "11111111-1111-4111-8111-111111111111",
    request: {
      version: 1,
      approvalId: "22222222-2222-4222-8222-222222222222",
      kind: "action",
      ownerId: "33333333-3333-4333-8333-333333333333",
      runId: "44444444-4444-4444-8444-444444444444",
      initiatorUserId: "55555555-5555-4555-8555-555555555555",
      browserPageId: "page-1",
      operation: "click",
      sourceOrigin: "https://example.test",
      destinationOrigin: "https://example.test",
      destinationFingerprint: "a".repeat(64),
      snapshotId: "b".repeat(64),
      targetFingerprint: "c".repeat(64),
      payloadFingerprint: "d".repeat(64),
      requestedAtMs: 1_000,
      expiresAtMs: 31_000,
      requestFingerprint: "e".repeat(64),
      display: {
        label: "click Sign in",
        destinationOrigin: "https://example.test",
      },
    },
  },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shared Browser approval transport", () => {
  it("strictly maps a pending request and treats an empty slot as no approval", () => {
    expect(mapRuntimeSharedBrowserPendingApprovalPayload({ pending: null })).toBeNull();
    expect(mapRuntimeSharedBrowserPendingApprovalPayload(pendingApprovalPayload)).toEqual(
      pendingApprovalPayload.pending,
    );
    expect(
      mapRuntimeSharedBrowserPendingApprovalPayload({
        ...pendingApprovalPayload,
        extra: true,
      }),
    ).toBeNull();
    expect(
      mapRuntimeSharedBrowserPendingApprovalPayload({
        pending: {
          ...pendingApprovalPayload.pending,
          request: {
            ...pendingApprovalPayload.pending.request,
            kind: "origin",
            operation: "click",
          },
        },
      }),
    ).toBeNull();
  });

  it("polls the exact runtime and page with browser view", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(pendingApprovalPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchRuntimeSharedBrowserPendingApproval({
        originEndpoint: "https://origin.example.test/",
        originAccessToken: "origin-token",
        runtimeId: pendingApprovalPayload.pending.runtimeId,
        browserPageId: pendingApprovalPayload.pending.request.browserPageId,
      }),
    ).resolves.toEqual(pendingApprovalPayload.pending);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://origin.example.test/browser/approval/pending?runtimeId=11111111-1111-4111-8111-111111111111&browserPageId=page-1",
    );
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer origin-token" }),
    );
  });

  it("surfaces transient gateway failures so a mounted prompt can reconnect", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchRuntimeSharedBrowserPendingApproval({
        originEndpoint: "https://origin.example.test/",
        originAccessToken: "origin-token",
        runtimeId: pendingApprovalPayload.pending.runtimeId,
        browserPageId: pendingApprovalPayload.pending.request.browserPageId,
      }),
    ).rejects.toThrow("browser approval request failed (503)");
  });

  it("submits only the server-bound decision fields with browser control", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          approvalId: pendingApprovalPayload.pending.request.approvalId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      decideRuntimeSharedBrowserApproval({
        originEndpoint: "https://origin.example.test/",
        originAccessToken: "origin-token",
        pending: pendingApprovalPayload.pending,
        decision: "allow_once",
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://origin.example.test/browser/approval/decision",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer origin-token" }),
        body: JSON.stringify({
          version: 1,
          runtimeId: pendingApprovalPayload.pending.runtimeId,
          ownerId: pendingApprovalPayload.pending.request.ownerId,
          runId: pendingApprovalPayload.pending.request.runId,
          browserPageId: pendingApprovalPayload.pending.request.browserPageId,
          approvalId: pendingApprovalPayload.pending.request.approvalId,
          requestFingerprint: pendingApprovalPayload.pending.request.requestFingerprint,
          decision: "allow_once",
        }),
      }),
    );
  });

  it("rejects a grant type that does not match the live request without network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      decideRuntimeSharedBrowserApproval({
        originEndpoint: "https://origin.example.test/",
        originAccessToken: "origin-token",
        pending: pendingApprovalPayload.pending,
        decision: "allow_origin",
      }),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
