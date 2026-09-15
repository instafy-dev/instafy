import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  readControllerError: readControllerErrorMock,
  resolveControllerRequestContext: resolveControllerRequestContextMock,
  runtimeControllerEnabled: true,
}));

import {
  acknowledgeControllerBugReportActivity,
  claimControllerSupportResolutionAlerts,
  getControllerBugReport,
  listControllerBugReportMessagePage,
  listControllerBugReportMessages,
  listControllerBugReportPage,
  listControllerBugReports,
  postControllerBugReportMessage,
  submitControllerBugReport,
} from "../bugReports";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const defaultRequestContext = Object.freeze({
  baseUrl: "http://controller.test",
  accessToken: "customer-token",
  credentialSource: "ambient" as const,
  generation: 1,
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("customer support report client", () => {
  beforeEach(() => {
    resolveControllerRequestContextMock.mockReset();
    resolveControllerRequestContextMock.mockResolvedValue(defaultRequestContext);
    readControllerErrorMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses only the forced-customer /support/reports routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: REPORT_ID, createdAt: "2026-09-05T10:00:00Z" }, 201))
      .mockResolvedValueOnce(jsonResponse({ reports: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: REPORT_ID,
          createdAt: "2026-09-05T10:00:00Z",
          updatedAt: "2026-09-05T10:00:00Z",
          message: "Something broke",
          details: "Steps",
          status: "open",
          projectId: null,
          runtimeId: null,
          runId: null,
          conversationId: null,
          screenshots: [],
          customerLastMessageAt: null,
          supportLastMessageAt: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await submitControllerBugReport({
      message: "Something broke",
      clientRequestId: "77777777-7777-4777-8777-777777777777",
    });
    await listControllerBugReports();
    await getControllerBugReport(REPORT_ID);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://controller.test/support/reports",
      "http://controller.test/support/reports?limit=25",
      `http://controller.test/support/reports/${REPORT_ID}`,
    ]);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("/bug-reports"))).toBe(true);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      message: "Something broke",
      clientRequestId: "77777777-7777-4777-8777-777777777777",
    });
  });

  it("pins a Studio report-list request to its observed account", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ reports: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listControllerBugReportPage(25, null, `  ${USER_ID}  `);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://controller.test/support/reports?limit=25&expected_user_id=${USER_ID}`,
      expect.objectContaining({
        headers: { authorization: "Bearer customer-token" },
      }),
    );
  });

  it("parses only customer-safe report and attachment fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          reports: [
            {
              id: REPORT_ID,
              createdAt: "2026-09-05T10:00:00Z",
              activityAt: "2026-09-05T11:00:00Z",
              updatedAt: "2026-09-05T11:00:00Z",
              message: "Broken button",
              status: "in_progress",
              projectId: "project-1",
              screenshotCount: 1,
              customerLastMessageAt: "2026-09-05T10:30:00Z",
              supportLastMessageAt: "2026-09-05T11:00:00Z",
              resolvedAt: "2026-09-05T10:59:00Z",
              hasUnreadSupportActivity: true,
              hasUnreadResolution: true,
              reporterEmail: "must-not-leak@example.com",
              logs: [{ message: "secret" }],
            },
          ],
          unreadCount: 3,
          unreadResolutionCount: 2,
          unnotifiedResolutionCount: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: REPORT_ID,
          createdAt: "2026-09-05T10:00:00Z",
          activityAt: "2026-09-05T11:00:00Z",
          updatedAt: "2026-09-05T11:00:00Z",
          message: "Broken button",
          details: "It does nothing",
          status: "in_progress",
          projectId: "project-1",
          runtimeId: "runtime-1",
          runId: "run-1",
          conversationId: "conversation-1",
          screenshots: [
            {
              id: "attachment-1",
              fileName: "screen.png",
              mediaType: "image/png",
              byteSize: 123,
              dataBase64: "must-not-be-read",
            },
          ],
          metadata: { secret: true },
          customerLastMessageAt: "2026-09-05T10:30:00Z",
          supportLastMessageAt: "2026-09-05T11:00:00Z",
          resolvedAt: "2026-09-05T10:59:00Z",
          hasUnreadSupportActivity: true,
          hasUnreadResolution: true,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const [summary] = await listControllerBugReports();
    const detail = await getControllerBugReport(REPORT_ID);

    expect(summary).toEqual({
      id: REPORT_ID,
      createdAt: "2026-09-05T10:00:00Z",
      activityAt: "2026-09-05T11:00:00Z",
      updatedAt: "2026-09-05T11:00:00Z",
      message: "Broken button",
      status: "in_progress",
      projectId: "project-1",
      screenshotCount: 1,
      customerLastMessageAt: "2026-09-05T10:30:00Z",
      supportLastMessageAt: "2026-09-05T11:00:00Z",
      resolvedAt: "2026-09-05T10:59:00Z",
      hasUnreadSupportActivity: true,
      hasUnreadResolution: true,
    });
    expect(detail.screenshots).toEqual([
      { id: "attachment-1", fileName: "screen.png", mediaType: "image/png", byteSize: 123 },
    ]);
    expect("metadata" in detail).toBe(false);
    expect("runtimeId" in detail).toBe(false);
    expect("runId" in detail).toBe(false);
    expect("conversationId" in detail).toBe(false);
    expect("dataBase64" in detail.screenshots[0]).toBe(false);
  });

  it("acknowledges an observed support cursor and atomically claims resolution alerts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          acknowledgedThrough: "2026-09-05T11:00:00Z",
          hasUnreadSupportActivity: false,
          hasUnreadResolution: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          claimedCount: 2,
          latestReportId: REPORT_ID,
          latestResolvedAt: "2026-09-05T11:05:00Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acknowledgeControllerBugReportActivity(REPORT_ID, "2026-09-05T11:00:00Z"),
    ).resolves.toEqual({
      acknowledgedThrough: "2026-09-05T11:00:00Z",
      hasUnreadSupportActivity: false,
      hasUnreadResolution: false,
    });
    await expect(claimControllerSupportResolutionAlerts("user-a")).resolves.toEqual({
      claimedCount: 2,
      latestReportId: REPORT_ID,
      latestResolvedAt: "2026-09-05T11:05:00Z",
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `http://controller.test/support/reports/${REPORT_ID}/acknowledge`,
      "http://controller.test/support/resolution-alerts/claim",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ seenThrough: "2026-09-05T11:00:00Z" }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedUserId: "user-a" }),
    });
  });

  it("pins exact support source IDs and rejects account changes while resolving", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ acknowledgedThrough: "2026-09-05T11:00:00Z", hasUnreadSupportActivity: false, hasUnreadResolution: false }));
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = { messageIds: ["33333333-3333-4333-8333-333333333333"], resolutionNotificationId: "44444444-4444-4444-8444-444444444444", expectedUserId: USER_ID, isCurrent: () => true };
    await acknowledgeControllerBugReportActivity(REPORT_ID, "2026-09-05T11:00:00Z", snapshot);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ seenThrough: "2026-09-05T11:00:00Z", messageIds: snapshot.messageIds, resolutionNotificationId: snapshot.resolutionNotificationId, expectedUserId: USER_ID });
    let active = true;
    resolveControllerRequestContextMock.mockImplementationOnce(async () => { active = false; return defaultRequestContext; });
    await expect(acknowledgeControllerBugReportActivity(REPORT_ID, "2026-09-05T11:00:00Z", { ...snapshot, isCurrent: () => active })).rejects.toThrow("session changed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses stable paired cursors for older report and message pages", async () => {
    const reportCursor = {
      activityAt: "2026-09-05T11:00:00Z",
      id: REPORT_ID,
    };
    const messageCursor = {
      createdAt: "2026-09-05T10:30:00Z",
      id: "22222222-2222-4222-8222-222222222222",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          reports: [
            {
              id: REPORT_ID,
              createdAt: "2026-09-05T10:00:00Z",
              activityAt: reportCursor.activityAt,
              updatedAt: reportCursor.activityAt,
              message: "Something broke",
              status: "open",
            },
          ],
          hasMore: true,
          nextCursor: reportCursor,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            {
              id: messageCursor.id,
              authorType: "support",
              body: "We are investigating.",
              createdAt: messageCursor.createdAt,
            },
          ],
          hasMore: true,
          nextCursor: messageCursor,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listControllerBugReportPage(50, reportCursor)).resolves.toMatchObject({
      hasMore: true,
      nextCursor: reportCursor,
      reports: [{ activityAt: reportCursor.activityAt }],
    });
    await expect(
      listControllerBugReportMessagePage(REPORT_ID, { limit: 100, before: messageCursor }),
    ).resolves.toMatchObject({
      hasMore: true,
      nextCursor: messageCursor,
      messages: [{ id: messageCursor.id }],
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `http://controller.test/support/reports?limit=50&before_activity_at=${encodeURIComponent(reportCursor.activityAt)}&before_activity_id=${REPORT_ID}`,
      `http://controller.test/support/reports/${REPORT_ID}/messages?limit=100&before_created_at=${encodeURIComponent(messageCursor.createdAt)}&before_message_id=${messageCursor.id}`,
    ]);
  });

  it("loads the customer thread and posts an idempotent follow-up", async () => {
    const supportMessage = {
      id: "22222222-2222-4222-8222-222222222222",
      authorType: "support",
      body: "We are investigating.",
      createdAt: "2026-09-05T11:00:00Z",
    };
    const customerMessage = {
      id: "33333333-3333-4333-8333-333333333333",
      authorType: "customer",
      body: "It happened again.",
      createdAt: "2026-09-05T11:05:00Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [supportMessage] }))
      .mockResolvedValueOnce(jsonResponse({ message: customerMessage }, 201));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", {
      randomUUID: () => "44444444-4444-4444-8444-444444444444",
    });

    await expect(listControllerBugReportMessages(REPORT_ID)).resolves.toEqual([supportMessage]);
    await expect(postControllerBugReportMessage(REPORT_ID, "  It happened again.  ")).resolves.toEqual(
      customerMessage,
    );

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`http://controller.test/support/reports/${REPORT_ID}/messages`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      body: "It happened again.",
      clientRequestId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("preserves a caller-owned retry id and counts message length by Unicode code point", async () => {
    const body = "😀".repeat(4_000);
    const clientRequestId = "55555555-5555-4555-8555-555555555555";
    const customerMessage = {
      id: "66666666-6666-4666-8666-666666666666",
      authorType: "customer",
      body,
      createdAt: "2026-09-05T11:10:00Z",
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: customerMessage }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postControllerBugReportMessage(REPORT_ID, body, clientRequestId),
    ).resolves.toEqual(customerMessage);
    await expect(
      postControllerBugReportMessage(REPORT_ID, `${body}😀`, clientRequestId),
    ).rejects.toThrow(/4,000 characters or shorter/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ body, clientRequestId });
  });
});
