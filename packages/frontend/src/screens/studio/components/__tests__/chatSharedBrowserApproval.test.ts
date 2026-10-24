import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../../types";
import { selectChatSharedBrowserApprovalTarget } from "../chatSharedBrowserApproval";

const userId = "55555555-5555-4555-8555-555555555555";
const runtimeId = "11111111-1111-4111-8111-111111111111";

function run(overrides: Partial<RunRecord> = {}, metadata: Record<string, unknown> = {}): RunRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    projectId: "project-1",
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "in_progress",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: {
      browserTransport: "shared",
      initiatingUserId: userId,
      browserRuntimeId: runtimeId.toUpperCase(),
      browserPageId: "page-of-the-job",
      ...metadata,
    },
    createdAt: "2026-10-24T07:50:00.000Z",
    updatedAt: "2026-10-24T07:55:00.000Z",
    ...overrides,
  } as RunRecord;
}

describe("selectChatSharedBrowserApprovalTarget", () => {
  it("takes the viewer's running Instafy's browser job, with its own machine and page", () => {
    const target = selectChatSharedBrowserApprovalTarget([run()], userId);
    expect(target).toMatchObject({
      runId: "44444444-4444-4444-8444-444444444444",
      runtimeId,
      browserPageId: "page-of-the-job",
    });
  });

  it.each([
    ["a teammate's run", run({}, { initiatingUserId: "66666666-6666-4666-8666-666666666666" })],
    ["a run without its initiator", run({}, { initiatingUserId: undefined })],
    ["a Personal Browser run", run({}, { browserTransport: "desktop-personal" })],
    ["a run with no browser", run({}, { browserTransport: undefined })],
    ["a queued run", run({ status: "queued" })],
    ["a finished run", run({ status: "success" })],
    ["a canceled run", run({ status: "canceled" })],
    ["a page id that is not one", run({}, { browserPageId: "page id with spaces" })],
    ["a machine that is not a UUID", run({}, { browserRuntimeId: "space" })],
    ["a run id that is not a UUID", run({ id: "run-1" })],
  ])("ignores %s", (_label, candidate) => {
    expect(selectChatSharedBrowserApprovalTarget([candidate], userId)).toBeNull();
  });

  it("asks nothing without a signed-in viewer", () => {
    expect(selectChatSharedBrowserApprovalTarget([run()], null)).toBeNull();
  });

  it("takes the newest when two match", () => {
    const older = run({ id: "77777777-7777-4777-8777-777777777777", updatedAt: "2026-10-24T07:00:00.000Z" }, { browserPageId: "older" });
    const newer = run({ id: "88888888-8888-4888-8888-888888888888", updatedAt: "2026-10-24T07:58:00.000Z" }, { browserPageId: "newer" });
    expect(selectChatSharedBrowserApprovalTarget([older, newer], userId)?.browserPageId).toBe("newer");
    expect(selectChatSharedBrowserApprovalTarget([newer, older], userId)?.browserPageId).toBe("newer");
  });
});
