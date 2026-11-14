import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveContext } = vi.hoisted(() => ({ resolveContext: vi.fn() }));
vi.mock("../projectNotFound", () => ({ reportControllerProjectNotFound: vi.fn() }));
vi.mock("../core", async () => ({
  // The error type and the reading of an error answer are the real ones.
  ...(await vi.importActual<typeof import("../core")>("../core")),
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
}));

import { ControllerApiError } from "../core";
import { sendControllerConversationMessage } from "../conversations";

const CONVERSATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("sendControllerConversationMessage", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue({ baseUrl: "https://controller.test", accessToken: "inert-session" });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a turn-engine claim and a one-send runtime pin as given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-1" })));
    vi.stubGlobal("fetch", fetchMock);
    await sendControllerConversationMessage({
      conversationId: CONVERSATION_ID,
      projectId: "project-1",
      promptText: "Fix the failing login test",
      metadata: { turnEngine: "claude-code", agentSelection: { active: ["octo"], mentions: ["octo"] } },
      runtimeId: "runtime-1",
      preferRuntime: false,
      expectedLaneIdle: true,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      promptText: "Fix the failing login test",
      metadata: { turnEngine: "claude-code", agentSelection: { active: ["octo"], mentions: ["octo"] } },
      runtimeId: "runtime-1",
      preferRuntime: false,
      expectedLaneIdle: true,
    });
  });

  it("keeps a refusal's code and details beside its text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: "Claude Code turn already active",
            code: "claude_code_turn_active",
            details: { reason: "start_window_passed" },
          }),
          { status: 409 },
        ),
      ),
    );
    const failure = await sendControllerConversationMessage({
      conversationId: CONVERSATION_ID,
      projectId: "project-1",
      promptText: "Fix the failing login test",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControllerApiError);
    expect(failure).toMatchObject({
      message: "Claude Code turn already active",
      status: 409,
      code: "claude_code_turn_active",
      details: { reason: "start_window_passed" },
    });
  });

  it("keeps the same text for any other failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));
    await expect(
      sendControllerConversationMessage({
        conversationId: CONVERSATION_ID,
        projectId: "project-1",
        promptText: "Fix the failing login test",
      }),
    ).rejects.toThrow("conversation message failed (502)");
  });
});
