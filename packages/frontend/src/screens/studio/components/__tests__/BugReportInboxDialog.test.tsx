// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acknowledgeActivity: vi.fn(),
  createMessageRequestId: vi.fn(),
  getReport: vi.fn(),
  listMessages: vi.fn(),
  listReports: vi.fn(),
  postMessage: vi.fn(),
  showStatus: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    bugReports: {
      acknowledgeActivity: mocks.acknowledgeActivity,
      createMessageRequestId: mocks.createMessageRequestId,
      get: mocks.getReport,
      listPage: mocks.listReports,
      listMessagePage: mocks.listMessages,
      postMessage: mocks.postMessage,
    },
  },
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
}));

vi.mock("../../../../runtime/runtimeMenuShared", () => ({
  writeClipboardText: mocks.writeClipboardText,
}));

import { BugReportInboxDialog as ProductionBugReportInboxDialog } from "../BugReportInboxDialog";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_REPORT_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

type TestInboxProps = Omit<
  ComponentProps<typeof ProductionBugReportInboxDialog>,
  "currentUserId" | "isUserSessionCurrent"
> &
  Partial<
    Pick<
      ComponentProps<typeof ProductionBugReportInboxDialog>,
      "currentUserId" | "isUserSessionCurrent"
    >
  >;

function BugReportInboxDialog({
  currentUserId = "user-a",
  isUserSessionCurrent = () => true,
  ...props
}: TestInboxProps) {
  return (
    <ProductionBugReportInboxDialog
      {...props}
      currentUserId={currentUserId}
      isUserSessionCurrent={isUserSessionCurrent}
    />
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsyncEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("BugReportInboxDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.createMessageRequestId.mockReset();
    mocks.createMessageRequestId.mockReturnValue(REQUEST_ID);
    mocks.acknowledgeActivity.mockReset();
    mocks.acknowledgeActivity.mockResolvedValue({
      acknowledgedThrough: "2026-09-05T11:00:00Z",
      hasUnreadSupportActivity: false,
      hasUnreadResolution: false,
    });
    mocks.showStatus.mockReset();
    mocks.writeClipboardText.mockReset();
    mocks.listReports.mockReset();
    mocks.listReports.mockResolvedValue({
      reports: [
        {
          id: REPORT_ID,
          createdAt: "2026-09-05T10:00:00Z",
          activityAt: "2026-09-05T11:00:00Z",
          updatedAt: "2026-09-05T11:00:00Z",
          message: "Publishing is stuck",
          status: "in_progress",
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          screenshotCount: 1,
          customerLastMessageAt: "2026-09-05T10:00:00Z",
          supportLastMessageAt: "2026-09-05T11:00:00Z",
          resolvedAt: null,
          hasUnreadSupportActivity: false,
          hasUnreadResolution: false,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    mocks.getReport.mockReset();
    mocks.getReport.mockResolvedValue({
      id: REPORT_ID,
      createdAt: "2026-09-05T10:00:00Z",
      activityAt: "2026-09-05T11:00:00Z",
      updatedAt: "2026-09-05T11:00:00Z",
      message: "Publishing is stuck",
      details: "The publish button stays busy.",
      status: "in_progress",
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      screenshots: [
        { id: "screen-1", fileName: "screen.png", mediaType: "image/png", byteSize: 123 },
      ],
      customerLastMessageAt: "2026-09-05T10:00:00Z",
      supportLastMessageAt: "2026-09-05T11:00:00Z",
      resolvedAt: null,
      hasUnreadSupportActivity: false,
      hasUnreadResolution: false,
    });
    mocks.listMessages.mockReset();
    mocks.listMessages.mockResolvedValue({
      messages: [
        {
          id: "message-1",
          authorType: "support",
          body: "We reproduced this and are preparing a fix.",
          createdAt: "2026-09-05T11:00:00Z",
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    mocks.postMessage.mockReset();
    mocks.postMessage.mockResolvedValue({
      id: "message-2",
      authorType: "customer",
      body: "Thanks — it still happens here.",
      createdAt: "2026-09-05T11:05:00Z",
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders a personal case timeline without exposing raw runtime context ids", async () => {
    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} onReportIssue={vi.fn()} />);
    });
    await flushAsyncEffects();

    expect(document.body.textContent).toContain("Your private support reports across all spaces");
    expect(document.body.textContent).toContain("Investigating");
    expect(document.body.textContent).toContain("The publish button stays busy.");
    expect(document.body.textContent).toContain("We reproduced this and are preparing a fix.");
    expect(document.body.textContent).toContain("Instafy Support");
    expect(document.body.textContent).not.toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(document.body.textContent).not.toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(document.body.textContent).not.toContain("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  it("keeps a status-only waiting update labeled as Waiting for you", async () => {
    const waitingSummary = {
      ...(await mocks.listReports())["reports"][0],
      status: "waiting_for_customer",
      customerLastMessageAt: "2026-09-05T10:00:00Z",
      supportLastMessageAt: "2026-09-05T11:00:00Z",
      hasUnreadSupportActivity: false,
    };
    mocks.listReports.mockReset();
    mocks.listReports.mockResolvedValue({
      reports: [waitingSummary],
      hasMore: false,
      nextCursor: null,
    });
    mocks.getReport.mockResolvedValue({
      ...(await mocks.getReport()),
      status: "waiting_for_customer",
      hasUnreadSupportActivity: false,
    });

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    expect(document.body.textContent).toContain("Waiting for you");
    expect(document.body.textContent).not.toContain("Support replied");
  });

  it("loads detail before the timeline and acknowledges only once the visible user can see both", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const detail = createDeferred<{
      id: string;
      createdAt: string;
      activityAt: string;
      updatedAt: string;
      message: string;
      details: string;
      status: string;
      projectId: null;
      screenshots: never[];
      customerLastMessageAt: string;
      supportLastMessageAt: string;
      resolvedAt: string;
      hasUnreadSupportActivity: boolean;
      hasUnreadResolution: boolean;
    }>();
    const timeline = createDeferred<{
      messages: Array<{
        id: string;
        authorType: "system";
        body: string;
        createdAt: string;
      }>;
      hasMore: false;
      nextCursor: null;
    }>();
    const onAcknowledged = vi.fn();
    mocks.getReport.mockReturnValueOnce(detail.promise);
    mocks.listMessages.mockReturnValueOnce(timeline.promise);

    await act(async () => {
      root.render(
        <BugReportInboxDialog
          isOpen
          onOpenChange={vi.fn()}
          onSupportActivityAcknowledged={onAcknowledged}
        />,
      );
    });
    await flushAsyncEffects();
    expect(mocks.getReport).toHaveBeenCalledWith(REPORT_ID);
    expect(mocks.listMessages).not.toHaveBeenCalled();
    expect(mocks.acknowledgeActivity).not.toHaveBeenCalled();

    await act(async () => {
      detail.resolve({
        id: REPORT_ID,
        createdAt: "2026-09-05T10:00:00Z",
        activityAt: "2026-09-05T11:00:00Z",
        updatedAt: "2026-09-05T11:00:00Z",
        message: "Publishing is stuck",
        details: "The fix is ready.",
        status: "resolved",
        projectId: null,
        screenshots: [],
        customerLastMessageAt: "2026-09-05T10:00:00Z",
        supportLastMessageAt: "2026-09-05T11:00:00Z",
        resolvedAt: "2026-09-05T10:59:59Z",
        hasUnreadSupportActivity: true,
        hasUnreadResolution: true,
      });
      await detail.promise;
    });
    await flushAsyncEffects();
    expect(mocks.listMessages).toHaveBeenCalledWith(REPORT_ID);
    expect(mocks.acknowledgeActivity).not.toHaveBeenCalled();

    visibilityState = "hidden";
    await act(async () => {
      timeline.resolve({
        messages: [
          {
            id: "status-resolved",
            authorType: "system",
            body: "Support marked this report as resolved.",
            createdAt: "2026-09-05T11:00:00Z",
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      await timeline.promise;
    });
    await flushAsyncEffects();

    expect(document.body.textContent).toContain("Support marked this report as resolved.");
    expect(mocks.acknowledgeActivity).not.toHaveBeenCalled();

    visibilityState = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flushAsyncEffects();

    expect(mocks.acknowledgeActivity).toHaveBeenCalledWith(
      REPORT_ID,
      "2026-09-05T11:00:00Z",
    );
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
  });

  it("keeps an off-page alert target selected and can retarget the same report", async () => {
    const list = createDeferred<{
      reports: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor: null;
    }>();
    const firstSummary = {
      id: REPORT_ID,
      createdAt: "2026-09-05T12:00:00Z",
      activityAt: "2026-09-05T12:00:00Z",
      updatedAt: "2026-09-05T12:00:00Z",
      message: "First-page report",
      status: "open",
      projectId: null,
      screenshotCount: 0,
      customerLastMessageAt: null,
      supportLastMessageAt: null,
      resolvedAt: null,
      hasUnreadSupportActivity: false,
      hasUnreadResolution: false,
    };
    mocks.listReports.mockReturnValueOnce(list.promise).mockResolvedValue({
      reports: [firstSummary],
      hasMore: false,
      nextCursor: null,
    });
    mocks.getReport.mockImplementation(async (reportId: string) => ({
      ...firstSummary,
      id: reportId,
      message: reportId === SECOND_REPORT_ID ? "Off-page resolved report" : "First-page report",
      details: reportId === SECOND_REPORT_ID ? "Target details" : "First details",
      screenshots: [],
    }));
    mocks.listMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });
    const renderWithRequest = async (requestKey: number) => {
      await act(async () => {
        root.render(
          <BugReportInboxDialog
            isOpen
            initialReportRequest={{ reportId: SECOND_REPORT_ID, requestKey }}
            onOpenChange={vi.fn()}
          />,
        );
      });
      await flushAsyncEffects();
    };

    await renderWithRequest(1);
    await act(async () => {
      list.resolve({ reports: [firstSummary], hasMore: false, nextCursor: null });
      await list.promise;
    });
    await flushAsyncEffects();
    expect(document.body.textContent).toContain("Target details");

    const initialTargetDetailCalls = mocks.getReport.mock.calls.filter(
      ([reportId]) => reportId === SECOND_REPORT_ID,
    ).length;
    const initialTargetTimelineCalls = mocks.listMessages.mock.calls.filter(
      ([reportId]) => reportId === SECOND_REPORT_ID,
    ).length;
    await renderWithRequest(2);
    expect(mocks.listReports).toHaveBeenCalledTimes(2);
    expect(
      mocks.getReport.mock.calls.filter(([reportId]) => reportId === SECOND_REPORT_ID),
    ).toHaveLength(initialTargetDetailCalls + 1);
    expect(
      mocks.listMessages.mock.calls.filter(([reportId]) => reportId === SECOND_REPORT_ID),
    ).toHaveLength(initialTargetTimelineCalls + 1);

    const firstButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("First-page report"),
    );
    await act(async () => firstButton?.click());
    await flushAsyncEffects();
    expect(document.body.textContent).toContain("First details");

    await renderWithRequest(3);
    expect(document.body.textContent).toContain("Target details");
  });

  it("refreshes both the selected row and detail when an alert retargets the same report", async () => {
    const initialPage = await mocks.listReports();
    const initialSummary = initialPage.reports[0];
    const initialDetail = await mocks.getReport();
    let resolved = false;
    mocks.listReports.mockReset();
    mocks.listReports.mockImplementation(async () => ({
      reports: [
        {
          ...initialSummary,
          status: resolved ? "resolved" : "in_progress",
          resolvedAt: resolved ? "2026-09-05T12:00:00Z" : null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    }));
    mocks.getReport.mockReset();
    mocks.getReport.mockImplementation(async () => ({
      ...initialDetail,
      status: resolved ? "resolved" : "in_progress",
      resolvedAt: resolved ? "2026-09-05T12:00:00Z" : null,
      hasUnreadSupportActivity: false,
      hasUnreadResolution: false,
    }));

    const renderWithRequest = async (requestKey: number) => {
      await act(async () => {
        root.render(
          <BugReportInboxDialog
            isOpen
            initialReportRequest={{ reportId: REPORT_ID, requestKey }}
            onOpenChange={vi.fn()}
          />,
        );
      });
      await flushAsyncEffects();
    };

    await renderWithRequest(1);
    expect(
      document.querySelector('[data-testid="bug-report-inbox-selected"]')?.textContent,
    ).toContain("Investigating");
    expect(
      document.querySelector('[data-testid="support-report-detail-status"]')?.textContent,
    ).toContain("Investigating");

    resolved = true;
    await renderWithRequest(2);

    expect(mocks.listReports).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[data-testid="bug-report-inbox-selected"]')?.textContent,
    ).toContain("Resolved");
    expect(
      document.querySelector('[data-testid="support-report-detail-status"]')?.textContent,
    ).toContain("Resolved");
  });

  it("sends a follow-up with a stable request id and refreshes the case timeline", async () => {
    const sentMessage = {
      id: "message-2",
      authorType: "customer",
      body: "Thanks — it still happens here.",
      createdAt: "2026-09-05T11:05:00Z",
    };
    mocks.getReport
      .mockResolvedValueOnce({
        id: REPORT_ID,
        createdAt: "2026-09-05T10:00:00Z",
        activityAt: "2026-09-05T11:00:00Z",
        updatedAt: "2026-09-05T11:00:00Z",
        message: "Publishing is stuck",
        details: "The publish button stays busy.",
        status: "resolved",
        projectId: null,
        screenshots: [],
        customerLastMessageAt: "2026-09-05T10:00:00Z",
        supportLastMessageAt: "2026-09-05T11:00:00Z",
      })
      .mockResolvedValueOnce({
        id: REPORT_ID,
        createdAt: "2026-09-05T10:00:00Z",
        activityAt: "2026-09-05T11:05:01Z",
        updatedAt: "2026-09-05T11:05:00Z",
        message: "Publishing is stuck",
        details: "The publish button stays busy.",
        status: "open",
        projectId: null,
        screenshots: [],
        customerLastMessageAt: "2026-09-05T11:05:00Z",
        supportLastMessageAt: "2026-09-05T11:00:00Z",
      });
    mocks.listMessages
      .mockResolvedValueOnce({ messages: [], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({
        messages: [
          sentMessage,
          {
            id: "message-reopened",
            authorType: "system",
            body: "Case reopened after your follow-up.",
            createdAt: "2026-09-05T11:05:01Z",
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
    mocks.postMessage.mockResolvedValueOnce(sentMessage);

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} onReportIssue={vi.fn()} />);
    });
    await flushAsyncEffects();

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "Thanks — it still happens here.");
      }
    });
    const form = textarea?.closest("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      REPORT_ID,
      "Thanks — it still happens here.",
      REQUEST_ID,
    );
    await flushAsyncEffects();
    expect(document.body.textContent).toContain("Thanks — it still happens here.");
    expect(document.body.textContent).toContain("Case reopened after your follow-up.");
    expect(document.body.textContent).toContain("Received");
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
  });

  it("suppresses a late reply result after the signed-in account changes", async () => {
    const pendingReply = createDeferred<{
      id: string;
      authorType: "customer";
      body: string;
      createdAt: string;
    }>();
    let activeUserId = "user-a";
    const isUserSessionCurrent = (expectedUserId: string) => expectedUserId === activeUserId;
    mocks.postMessage.mockReturnValueOnce(pendingReply.promise);

    await act(async () => {
      root.render(
        <BugReportInboxDialog
          key={activeUserId}
          isOpen
          currentUserId={activeUserId}
          isUserSessionCurrent={isUserSessionCurrent}
          onOpenChange={vi.fn()}
        />,
      );
    });
    await flushAsyncEffects();
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    await act(async () => {
      if (textarea) setTextareaValue(textarea, "This reply belongs to account A.");
    });
    await act(async () => {
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mocks.postMessage).toHaveBeenCalledTimes(1);

    activeUserId = "user-b";
    await act(async () => {
      root.render(
        <BugReportInboxDialog
          key={activeUserId}
          isOpen
          currentUserId={activeUserId}
          isUserSessionCurrent={isUserSessionCurrent}
          onOpenChange={vi.fn()}
        />,
      );
    });
    await flushAsyncEffects();
    const listCallsBeforeOldReplyCompletes = mocks.listReports.mock.calls.length;

    await act(async () => {
      pendingReply.resolve({
        id: "old-account-message",
        authorType: "customer",
        body: "This reply belongs to account A.",
        createdAt: "2026-09-05T12:30:00Z",
      });
      await pendingReply.promise;
    });
    await flushAsyncEffects();

    expect(mocks.showStatus).not.toHaveBeenCalledWith(
      "Message sent to Instafy Support.",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.listReports).toHaveBeenCalledTimes(listCallsBeforeOldReplyCompletes);
  });

  it("reuses the same request id when the same reply is retried after an uncertain failure", async () => {
    mocks.postMessage
      .mockRejectedValueOnce(new Error("The connection closed before support replied."))
      .mockResolvedValueOnce({
        id: "message-retry",
        authorType: "customer",
        body: "Retry this exact reply.",
        createdAt: "2026-09-05T11:10:00Z",
      });

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "Retry this exact reply.");
      }
    });
    const form = textarea?.closest("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushAsyncEffects();

    expect(document.body.textContent).toContain("connection closed");

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushAsyncEffects();

    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage.mock.calls[0]?.[2]).toBe(REQUEST_ID);
    expect(mocks.postMessage.mock.calls[1]?.[2]).toBe(REQUEST_ID);
    expect(mocks.createMessageRequestId).toHaveBeenCalledTimes(1);
  });

  it("does not apply a late reply result to a newly selected report or its draft", async () => {
    const pendingReply = createDeferred<{
      id: string;
      authorType: "customer";
      body: string;
      createdAt: string;
    }>();
    mocks.listReports.mockResolvedValue({
      reports: [
        {
          id: REPORT_ID,
          createdAt: "2026-09-05T10:00:00Z",
          activityAt: "2026-09-05T11:00:00Z",
          updatedAt: "2026-09-05T11:00:00Z",
          message: "Publishing is stuck",
          status: "in_progress",
          projectId: null,
          screenshotCount: 0,
          customerLastMessageAt: null,
          supportLastMessageAt: null,
        },
        {
          id: SECOND_REPORT_ID,
          createdAt: "2026-09-05T12:00:00Z",
          activityAt: "2026-09-05T12:00:00Z",
          updatedAt: "2026-09-05T12:00:00Z",
          message: "Second report",
          status: "open",
          projectId: null,
          screenshotCount: 0,
          customerLastMessageAt: null,
          supportLastMessageAt: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    mocks.getReport.mockImplementation(async (reportId: string) => ({
      id: reportId,
      createdAt: "2026-09-05T12:00:00Z",
      activityAt: "2026-09-05T12:00:00Z",
      updatedAt: "2026-09-05T12:00:00Z",
      message: reportId === REPORT_ID ? "Publishing is stuck" : "Second report",
      details: reportId === REPORT_ID ? "First report details" : "Second report details",
      status: "open",
      projectId: null,
      screenshots: [],
      customerLastMessageAt: null,
      supportLastMessageAt: null,
    }));
    mocks.listMessages.mockImplementation(async (reportId: string) => ({
      messages: reportId === REPORT_ID
        ? []
        : [
            {
              id: "message-second",
              authorType: "support",
              body: "This belongs to the second report.",
              createdAt: "2026-09-05T12:01:00Z",
            },
          ],
      hasMore: false,
      nextCursor: null,
    }));
    mocks.postMessage.mockReturnValueOnce(pendingReply.promise);

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    let textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "Reply submitted for the first report.");
      }
    });
    await act(async () => {
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const secondReportButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Second report"),
    );
    await act(async () => secondReportButton?.click());
    await flushAsyncEffects();

    textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "A draft for the second report.");
      }
    });
    await act(async () => {
      pendingReply.resolve({
        id: "late-first-message",
        authorType: "customer",
        body: "Reply submitted for the first report.",
        createdAt: "2026-09-05T12:02:00Z",
      });
      await pendingReply.promise;
    });
    await flushAsyncEffects();

    expect(document.body.textContent).toContain("This belongs to the second report.");
    expect(document.body.textContent).not.toContain("Reply submitted for the first report.");
    expect(
      document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]')?.value,
    ).toBe("A draft for the second report.");
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("preserves a newer draft when the submitted reply finishes", async () => {
    const pendingReply = createDeferred<{
      id: string;
      authorType: "customer";
      body: string;
      createdAt: string;
    }>();
    mocks.postMessage.mockReturnValueOnce(pendingReply.promise);

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "Submitted draft.");
      }
    });
    await act(async () => {
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "New details typed while sending.");
      }
    });
    await act(async () => {
      pendingReply.resolve({
        id: "submitted-message",
        authorType: "customer",
        body: "Submitted draft.",
        createdAt: "2026-09-05T12:05:00Z",
      });
      await pendingReply.promise;
    });
    await flushAsyncEffects();

    expect(
      document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]')?.value,
    ).toBe("New details typed while sending.");
  });

  it("accepts 4,000 astral characters using Unicode code-point counting", async () => {
    const message = "😀".repeat(4_000);
    mocks.postMessage.mockResolvedValueOnce({
      id: "unicode-message",
      authorType: "customer",
      body: message,
      createdAt: "2026-09-05T12:10:00Z",
    });

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    expect(textarea?.hasAttribute("maxlength")).toBe(false);
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, message);
      }
    });
    await act(async () => {
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(REPORT_ID, message, REQUEST_ID);
  });

  it("rejects 4,001 astral characters before posting", async () => {
    const message = "😀".repeat(4_001);
    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="support-reply"]');
    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, message);
      }
    });
    await act(async () => {
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("4,000 characters or shorter");
  });

  it("loads and deduplicates older report pages without changing the selection", async () => {
    const cursor = {
      activityAt: "2026-09-05T11:00:00Z",
      id: REPORT_ID,
    };
    const firstReport = {
      id: REPORT_ID,
      createdAt: "2026-09-05T10:00:00Z",
      activityAt: cursor.activityAt,
      updatedAt: cursor.activityAt,
      message: "Publishing is stuck",
      status: "in_progress",
      projectId: null,
      screenshotCount: 0,
      customerLastMessageAt: null,
      supportLastMessageAt: null,
    };
    const olderReport = {
      id: SECOND_REPORT_ID,
      createdAt: "2026-09-04T10:00:00Z",
      activityAt: "2026-09-04T10:00:00Z",
      updatedAt: "2026-09-04T10:00:00Z",
      message: "An older support report",
      status: "open",
      projectId: null,
      screenshotCount: 0,
      customerLastMessageAt: null,
      supportLastMessageAt: null,
    };
    mocks.listReports
      .mockResolvedValueOnce({ reports: [firstReport], hasMore: true, nextCursor: cursor })
      .mockResolvedValueOnce({
        reports: [{ ...firstReport, status: "resolved" }, olderReport],
        hasMore: false,
        nextCursor: null,
      });

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    const selectedBefore = document.querySelector<HTMLElement>(
      '[data-testid="bug-report-inbox-selected"]',
    );
    expect(selectedBefore?.textContent).toContain("Publishing is stuck");
    const loadMore = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Load more reports",
    );
    expect(loadMore).toBeTruthy();
    await act(async () => loadMore?.click());
    await flushAsyncEffects();

    expect(mocks.listReports).toHaveBeenNthCalledWith(1, 50, null, "user-a");
    expect(mocks.listReports).toHaveBeenNthCalledWith(2, 50, cursor, "user-a");
    const reportList = document.querySelector('[role="list"][aria-label="Your support reports"]');
    expect(reportList?.textContent).toContain("An older support report");
    expect(
      Array.from(reportList?.querySelectorAll("button") ?? []).filter((button) =>
        button.textContent?.includes("Publishing is stuck"),
      ),
    ).toHaveLength(1);
    expect(
      document.querySelector<HTMLElement>('[data-testid="bug-report-inbox-selected"]')?.textContent,
    ).toContain("Publishing is stuck");
  });

  it("ignores a stale report list after reopening starts a newer request", async () => {
    const pendingInitial = createDeferred<{
      reports: Array<{
        id: string;
        createdAt: string;
        activityAt: string;
        updatedAt: string;
        message: string;
        status: string;
        projectId: null;
        screenshotCount: number;
        customerLastMessageAt: null;
        supportLastMessageAt: null;
      }>;
      hasMore: false;
      nextCursor: null;
    }>();
    const staleReport = {
      id: REPORT_ID,
      createdAt: "2026-09-05T10:00:00Z",
      activityAt: "2026-09-05T10:00:00Z",
      updatedAt: "2026-09-05T10:00:00Z",
      message: "Stale support report",
      status: "open",
      projectId: null,
      screenshotCount: 0,
      customerLastMessageAt: null,
      supportLastMessageAt: null,
    };
    const currentReport = {
      ...staleReport,
      id: SECOND_REPORT_ID,
      message: "Current support report",
    };
    mocks.listReports
      .mockReturnValueOnce(pendingInitial.promise)
      .mockResolvedValueOnce({ reports: [currentReport], hasMore: false, nextCursor: null });
    mocks.getReport.mockImplementation(async (id: string) => ({
      ...(id === currentReport.id ? currentReport : staleReport),
      details: `${id === currentReport.id ? "Current" : "Stale"} report details`,
      runtimeId: null,
      runId: null,
      conversationId: null,
      screenshots: [],
    }));

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await act(async () => {
      root.render(<BugReportInboxDialog isOpen={false} onOpenChange={vi.fn()} />);
    });
    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();
    expect(document.body.textContent).toContain("Current support report");

    await act(async () => {
      pendingInitial.resolve({ reports: [staleReport], hasMore: false, nextCursor: null });
      await pendingInitial.promise;
    });

    expect(document.body.textContent).toContain("Current support report");
    expect(document.body.textContent).not.toContain("Stale support report");
  });

  it("prepends and deduplicates older customer-visible message pages", async () => {
    const cursor = {
      createdAt: "2026-09-05T10:30:00Z",
      id: "message-middle",
    };
    const middleMessage = {
      id: cursor.id,
      authorType: "support",
      body: "Boundary message from support.",
      createdAt: cursor.createdAt,
    };
    const newestMessage = {
      id: "message-newest",
      authorType: "customer",
      body: "Newest customer follow-up.",
      createdAt: "2026-09-05T11:00:00Z",
    };
    const oldestMessage = {
      id: "message-oldest",
      authorType: "support",
      body: "Oldest support update.",
      createdAt: "2026-09-05T10:15:00Z",
    };
    mocks.listMessages
      .mockResolvedValueOnce({
        messages: [middleMessage, newestMessage],
        hasMore: true,
        nextCursor: cursor,
      })
      .mockResolvedValueOnce({
        messages: [oldestMessage, middleMessage],
        hasMore: false,
        nextCursor: null,
      });

    await act(async () => {
      root.render(<BugReportInboxDialog isOpen onOpenChange={vi.fn()} />);
    });
    await flushAsyncEffects();

    const loadOlder = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Load older messages",
    );
    expect(loadOlder).toBeTruthy();
    await act(async () => loadOlder?.click());
    await flushAsyncEffects();

    expect(mocks.listMessages).toHaveBeenNthCalledWith(1, REPORT_ID);
    expect(mocks.listMessages).toHaveBeenNthCalledWith(2, REPORT_ID, {
      limit: 100,
      before: cursor,
    });
    const timeline = document.querySelector<HTMLElement>('[data-testid="support-message-timeline"]');
    const text = timeline?.textContent ?? "";
    expect(text.indexOf(oldestMessage.body)).toBeLessThan(text.indexOf(middleMessage.body));
    expect(text.indexOf(middleMessage.body)).toBeLessThan(text.indexOf(newestMessage.body));
    expect(text.match(/Boundary message from support\./gu)).toHaveLength(1);
  });

  it("opens a new issue from Support", async () => {
    const onOpenChange = vi.fn();
    const onReportIssue = vi.fn();
    await act(async () => {
      root.render(
        <BugReportInboxDialog
          isOpen
          onOpenChange={onOpenChange}
          onReportIssue={onReportIssue}
        />,
      );
    });
    await flushAsyncEffects();

    const button = document.querySelector<HTMLButtonElement>('[data-testid="support-new-report"]');
    await act(async () => button?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onReportIssue).toHaveBeenCalledTimes(1);
  });
});
