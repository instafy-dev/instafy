import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";
import {
  RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS,
  RATE_LIMIT_AUTO_RETRY_MAX_DELAY_MS,
  RATE_LIMIT_AUTO_RETRY_MIN_DELAY_MS,
  RETRYING_STATUS_DISPLAY_TEXT,
  RUN_FAILURE_AUTO_RETRY_MAX_AGE_MS,
  RUN_FAILURE_RETRY_OF_METADATA_KEY,
  buildRunFailureRetryMetadata,
  classifyRunFailureText,
  hasFailedRunMetadata,
  isAutoRetryEligibleFailureKind,
  isBrowserRoutedPromptMetadata,
  isRunFailurePromptAutoResendable,
  isRunFailurePromptFromThisClient,
  isRunFailurePromptSharedWithOtherRuns,
  isRunFailureRecentForAutoRetry,
  isRunFailureRetryQueued,
  isRunFailureRetrySuperseded,
  isRunFailureRunSteered,
  parseRunFailureRetryAfterMs,
  resolveRetryingStatusPresentation,
  resolveRunFailureAutoRetryDelayMs,
  resolveRunFailurePresentation,
  resolveRunFailureRetryPrompt,
  readRunFailureRetryOf,
  readRunFailureRunIds,
  resolveRunFailureRetrySource,
  runFailureOriginKey,
} from "../runFailurePresentation";

const MISSING_FINAL_MESSAGE =
  "Codex completed without returning a final assistant message after retry. The run trace contains the raw Codex events for debugging.";
const STOPPED_AFTER_PROGRESS =
  'Codex stopped after a progress update without returning the required final JSON after retry. Last progress output: "Wiring the preview server."';
const NO_WORKSPACE_CHANGES =
  "Codex did not apply any workspace changes for a file-modifying request.";
const MISSING_COMMAND_OBSERVATION =
  "Codex did not execute the command observation required by runtime routing, even after retry.";
const MISSING_MCP_TOOL =
  "Codex did not execute any non-browser MCP tool calls for an MCP-requested run, even after retry.";
// Codex's wording when the model provider answers 429. No retry actually ran.
const PROVIDER_RATE_LIMITED = "exceeded retry limit, last status: 429 Too Many Requests";
const PROVIDER_RATE_LIMITED_TEXT =
  "The AI provider is limiting requests right now, so this turn stopped. Wait a little, then try again. If it keeps happening, the provider account may have reached its usage limit.";
// 429s that name an exhausted quota or plan window. Retrying soon will not help.
const PROVIDER_INSUFFICIENT_QUOTA =
  'backend responded with 429 Too Many Requests: {"error":{"type":"insufficient_quota","code":"insufficient_quota"}}';
const PROVIDER_USAGE_LIMIT_REACHED =
  'backend responded with 429 Too Many Requests: {"error":{"type":"usage_limit_reached"}}';
// The proxy streams a transient 429 as a failure that names its wait, and Codex
// reports it this way once its retries run out.
const PROXY_STREAMED_RATE_LIMIT =
  "stream disconnected before completion: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 5.5s.";
// Codex's own message when the provider stopped the answer early and the
// response did not come through the Instafy proxy, which completes it instead.
const RESPONSE_INCOMPLETE = (reason: string) => `Incomplete response returned, reason: ${reason}`;
// The runtime agent's refusals of a browser task that names no usable page
// (shared_browser.rs and codex.rs). Older Studio tabs could send one without a
// page, and a page inferred from chat history has its URL as the id.
const BROWSER_PAGE_MISSING = "Shared Browser job is missing its UI-selected browserPageId";
const BROWSER_PAGE_MISSING_FOR_MCP =
  "Shared Browser MCP requires the job's UI-selected browserPageId";
const BROWSER_PAGE_INVALID = "Shared Browser browserPageId must be one bounded CDP target id";
const BROWSER_PAGE_MISSING_TEXT =
  "This was sent as a browser task without a page to work on, so nothing ran. Try again from Chat, or open a page in the browser first.";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

describe("classifyRunFailureText", () => {
  it("classifies missing final assistant messages", () => {
    expect(classifyRunFailureText(MISSING_FINAL_MESSAGE)).toBe("missing_final_message");
    expect(classifyRunFailureText(STOPPED_AFTER_PROGRESS)).toBe("missing_final_message");
    expect(
      classifyRunFailureText(
        'Codex returned assistant text instead of the required final JSON after retry. Last assistant output: "done"',
      ),
    ).toBe("missing_final_message");
  });

  it("classifies missing workspace changes", () => {
    expect(classifyRunFailureText(NO_WORKSPACE_CHANGES)).toBe("no_workspace_changes");
    expect(
      classifyRunFailureText(
        "Retrying: the previous Codex reply listed file changes, but no files were actually written to the workspace.",
      ),
    ).toBe("no_workspace_changes");
  });

  it("classifies missing verification observations", () => {
    expect(classifyRunFailureText(MISSING_COMMAND_OBSERVATION)).toBe("missing_verification");
    expect(classifyRunFailureText(MISSING_MCP_TOOL)).toBe("missing_verification");
  });

  it("classifies missing-credential failures as needs_ai", () => {
    expect(classifyRunFailureText("credential not found")).toBe("needs_ai");
    expect(classifyRunFailureText("proxy error: no default credential for this run")).toBe("needs_ai");
    expect(classifyRunFailureText("the run requires user credentials")).toBe("needs_ai");
    expect(classifyRunFailureText("No AI provider is connected for this project.")).toBe("needs_ai");
  });

  it("classifies a model provider rate limit", () => {
    expect(classifyRunFailureText(PROVIDER_RATE_LIMITED)).toBe("provider_rate_limited");
    expect(
      classifyRunFailureText(
        "exceeded retry limit, last status: 429 Too Many Requests, request id: req_123",
      ),
    ).toBe("provider_rate_limited");
    expect(
      classifyRunFailureText(
        '{"error":{"message":"The upstream provider rate limit was reached.","type":"upstream_error","code":"upstream_rate_limit","retryable":true}}',
      ),
    ).toBe("provider_rate_limited");
    // The proxy's answer when the exhausted window resets in hours: terminal, still a rate limit.
    expect(
      classifyRunFailureText(
        '{"error":{"message":"The upstream provider rate limit was reached.","type":"upstream_error","code":"upstream_rate_limit","retryable":false}}',
      ),
    ).toBe("provider_rate_limited");
    expect(
      classifyRunFailureText(
        'backend responded with 429 Too Many Requests: {"error":{"type":"rate_limit_error","message":"Rate limit reached"}}',
      ),
    ).toBe("provider_rate_limited");
    expect(classifyRunFailureText(PROXY_STREAMED_RATE_LIMIT)).toBe("provider_rate_limited");
    // A retry limit on another status is not a rate limit.
    expect(
      classifyRunFailureText("exceeded retry limit, last status: 500 Internal Server Error"),
    ).toBeNull();
  });

  it("does not blame the AI provider for a 429 from something else", () => {
    // A throttled skill import and the scoped worker proxy fail with the same
    // phrase, but neither is the model provider.
    expect(
      classifyRunFailureText(
        "https://raw.githubusercontent.com/instafy-dev/skills/main/SKILL.md returned 429 Too Many Requests",
      ),
    ).toBeNull();
    expect(
      classifyRunFailureText(
        "Scoped worker proxy request failed with status 429 Too Many Requests: slow down",
      ),
    ).toBeNull();
  });

  it("does not call a 429 that names an exhausted quota or plan limit a passing rate limit", () => {
    expect(classifyRunFailureText(PROVIDER_INSUFFICIENT_QUOTA)).toBeNull();
    expect(classifyRunFailureText(PROVIDER_USAGE_LIMIT_REACHED)).toBeNull();
    expect(
      classifyRunFailureText(
        'exceeded retry limit, last status: 429 Too Many Requests: {"error":{"type":"usage_not_included"}}',
      ),
    ).toBeNull();
    expect(
      classifyRunFailureText("exceeded retry limit, last status: 429 Too Many Requests (quota exceeded)"),
    ).toBeNull();
    expect(
      classifyRunFailureText(
        'exceeded retry limit, last status: 429 Too Many Requests: {"error":{"code":"quota_exceeded"}}',
      ),
    ).toBeNull();
  });

  it("classifies an answer the provider stopped early", () => {
    for (const reason of ["max_output_tokens", "content_filter", "unknown"]) {
      expect(classifyRunFailureText(RESPONSE_INCOMPLETE(reason))).toBe("response_incomplete");
    }
    expect(
      classifyRunFailureText(`Codex run failed: ${RESPONSE_INCOMPLETE("max_output_tokens")}`),
    ).toBe("response_incomplete");
    expect(classifyRunFailureText("The response was incomplete.")).toBeNull();
  });

  it("classifies a browser task that named no usable page", () => {
    for (const rawText of [BROWSER_PAGE_MISSING, BROWSER_PAGE_MISSING_FOR_MCP, BROWSER_PAGE_INVALID]) {
      expect(classifyRunFailureText(rawText)).toBe("browser_page_missing");
    }
    expect(classifyRunFailureText("Open the browser page and check the title.")).toBeNull();
  });

  it("returns null for unrelated text", () => {
    expect(classifyRunFailureText("Codex run timed out")).toBeNull();
    expect(classifyRunFailureText("All tests pass.")).toBeNull();
  });
});

// The controller labels a failed run in the agent's history with its own copy
// of the rate limit patterns. Both sides read this one fixture list, so a
// pattern changed on one side and not the other fails here and in the Rust
// unit test at once.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const RUN_FAILURE_FIXTURES = resolve(
  repo,
  "packages/runtime-controller/src/run_failure_fixtures.json",
);
const runFailureFixtures = JSON.parse(readFileSync(RUN_FAILURE_FIXTURES, "utf8")) as {
  cases: { name: string; text: string; providerRateLimited: boolean }[];
};

describe("provider rate limit fixtures shared with the controller", () => {
  it("reads the shared fixture list", () => {
    expect(runFailureFixtures.cases.length).toBeGreaterThanOrEqual(15);
  });

  it.each(runFailureFixtures.cases.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      expect(classifyRunFailureText(fixture.text) === "provider_rate_limited").toBe(
        fixture.providerRateLimited,
      );
    },
  );
});

describe("hasFailedRunMetadata", () => {
  it("accepts agent failure metadata emitted by the controller", () => {
    expect(
      hasFailedRunMetadata({
        source: "agent",
        outcome: "failed",
        messageType: "error",
        jobId: "job-1",
      }),
    ).toBe(true);
  });

  it("accepts synthesized terminal run metadata", () => {
    expect(
      hasFailedRunMetadata({
        source: "agent",
        kind: "result",
        outcome: "failed",
        status: "failed",
        jobId: "job-1",
        runId: "run-1",
      }),
    ).toBe(true);
  });

  it("rejects non-failed outcomes and non-agent errors", () => {
    expect(hasFailedRunMetadata({ source: "agent", outcome: "success" })).toBe(false);
    expect(hasFailedRunMetadata({ outcome: "failed" })).toBe(false);
    expect(hasFailedRunMetadata(null)).toBe(false);
  });
});

describe("isAutoRetryEligibleFailureKind", () => {
  it("is true for the transient kinds", () => {
    expect(isAutoRetryEligibleFailureKind("missing_final_message")).toBe(true);
    expect(isAutoRetryEligibleFailureKind("no_workspace_changes")).toBe(true);
    // Codex already retried the 429 inside the turn; one more resend after a
    // visible countdown usually gets through (see resolveRunFailureAutoRetryDelayMs).
    expect(isAutoRetryEligibleFailureKind("provider_rate_limited")).toBe(true);
  });

  it("is false for deterministic/unhelpful kinds and nullish input", () => {
    expect(isAutoRetryEligibleFailureKind("missing_verification")).toBe(false);
    expect(isAutoRetryEligibleFailureKind("needs_ai")).toBe(false);
    // The provider billed the cut-short answer; the same request would stop the same way.
    expect(isAutoRetryEligibleFailureKind("response_incomplete")).toBe(false);
    // Nothing changes until the person opens a page or resends from Chat.
    expect(isAutoRetryEligibleFailureKind("browser_page_missing")).toBe(false);
    // The turn may have been stopped on purpose; a resend would ask for a machine again.
    expect(isAutoRetryEligibleFailureKind("interrupted_run_expired")).toBe(false);
    expect(isAutoRetryEligibleFailureKind("generic")).toBe(false);
    expect(isAutoRetryEligibleFailureKind(null)).toBe(false);
    expect(isAutoRetryEligibleFailureKind(undefined)).toBe(false);
  });
});

describe("parseRunFailureRetryAfterMs", () => {
  it("reads the wait a rate limit names", () => {
    expect(parseRunFailureRetryAfterMs(PROXY_STREAMED_RATE_LIMIT)).toBe(5_500);
    expect(parseRunFailureRetryAfterMs("Rate limit reached. Please try again in 12s.")).toBe(12_000);
    expect(parseRunFailureRetryAfterMs("Please try again in 30 seconds")).toBe(30_000);
    expect(parseRunFailureRetryAfterMs("Please try again in 750ms.")).toBe(750);
  });

  it("is null when the text names no wait", () => {
    expect(parseRunFailureRetryAfterMs(PROVIDER_RATE_LIMITED)).toBeNull();
    expect(parseRunFailureRetryAfterMs("Workspace is busy. Try again in a moment.")).toBeNull();
  });
});

describe("resolveRunFailureAutoRetryDelayMs", () => {
  const presentationFor = (rawText: string) => {
    const presentation = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: "job-1" },
      content: rawText,
    });
    if (!presentation) {
      throw new Error(`no presentation for ${rawText}`);
    }
    return presentation;
  };

  it("resends the hiccup kinds at once", () => {
    expect(resolveRunFailureAutoRetryDelayMs({ presentation: presentationFor(MISSING_FINAL_MESSAGE) })).toBe(0);
    expect(resolveRunFailureAutoRetryDelayMs({ presentation: presentationFor(NO_WORKSPACE_CHANGES) })).toBe(0);
  });

  it("keeps Codex's bare 429 manual, because a spent plan window reads the same", () => {
    // Nothing in this text says the limit is short, and a usage limit must
    // never be retried automatically.
    expect(
      resolveRunFailureAutoRetryDelayMs({ presentation: presentationFor(PROVIDER_RATE_LIMITED) }),
    ).toBeNull();
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor("backend responded with 429 Too Many Requests"),
      }),
    ).toBeNull();
  });

  it("waits 20 seconds before resending a retryable rate limit that names no wait", () => {
    expect(RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS).toBe(20_000);
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(
          'exceeded retry limit, last status: 429 Too Many Requests, body: {"error":{"code":"upstream_rate_limit","retryable":true}}',
        ),
      }),
    ).toBe(RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS);
  });

  it("uses the wait the rate limit names, within 5 to 60 seconds", () => {
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(
          "stream disconnected before completion: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 28.5s.",
        ),
      }),
    ).toBe(28_500);
    expect(
      resolveRunFailureAutoRetryDelayMs({ presentation: presentationFor(PROXY_STREAMED_RATE_LIMIT) }),
    ).toBe(5_500);
    // Too short to read or cancel: raised to the floor.
    expect(RATE_LIMIT_AUTO_RETRY_MIN_DELAY_MS).toBe(5_000);
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(
          "Codex stream aborted after 1 retries (limit 1): stream disconnected before completion: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 1s.",
        ),
      }),
    ).toBe(RATE_LIMIT_AUTO_RETRY_MIN_DELAY_MS);
    // Longer than anyone should watch a countdown: capped.
    expect(RATE_LIMIT_AUTO_RETRY_MAX_DELAY_MS).toBe(60_000);
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(
          "exceeded retry limit, last status: 429 Too Many Requests. Please try again in 600s.",
        ),
      }),
    ).toBe(RATE_LIMIT_AUTO_RETRY_MAX_DELAY_MS);
  });

  it("keeps a rate limit the proxy marked not retryable manual", () => {
    // A window that reopens in hours: any resend soon would fail the same way.
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(
          '{"error":{"message":"The upstream provider rate limit was reached.","type":"upstream_error","code":"upstream_rate_limit","retryable":false}}',
        ),
      }),
    ).toBeNull();
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(
          '{"error":{"message":"The upstream provider rate limit was reached.","type":"upstream_error","code":"upstream_rate_limit","retryable":true}}',
        ),
      }),
    ).toBe(RATE_LIMIT_AUTO_RETRY_DEFAULT_DELAY_MS);
  });

  it("never resends a spent quota or plan limit, a missing credential or the other manual kinds", () => {
    for (const rawText of [
      PROVIDER_INSUFFICIENT_QUOTA,
      PROVIDER_USAGE_LIMIT_REACHED,
      "credential not found",
      MISSING_COMMAND_OBSERVATION,
      RESPONSE_INCOMPLETE("max_output_tokens"),
      "Codex run timed out",
    ]) {
      expect(
        resolveRunFailureAutoRetryDelayMs({ presentation: presentationFor(rawText) }),
        rawText,
      ).toBeNull();
    }
  });

  it("never resends a prompt that drove a browser page, whatever the failure", () => {
    const content = "Click the sign up button";
    for (const rawText of [PROXY_STREAMED_RATE_LIMIT, MISSING_FINAL_MESSAGE, NO_WORKSPACE_CHANGES]) {
      const presentation = presentationFor(rawText);
      for (const metadata of [
        { browserTransport: "shared", browserRuntimeId: "runtime-1" },
        { browserTransport: "desktop-personal" },
        { browserPageId: "page-1" },
        { runtimeExpectations: { browserExecution: true } },
      ]) {
        expect(
          resolveRunFailureAutoRetryDelayMs({ presentation, promptMessage: { content, metadata } }),
          `${rawText} ${JSON.stringify(metadata)}`,
        ).toBeNull();
      }
    }
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(PROXY_STREAMED_RATE_LIMIT),
        promptMessage: { content, metadata: { runtimeExpectations: { browserExecution: false } } },
      }),
    ).toBe(5_500);
  });

  it("never resends a prompt whose dispatched text differs from what it shows", () => {
    // Targeting an open browser page stores only the wrapped text it sent; a
    // resend would carry the plain text and miss that page.
    const metadata = {
      prompt_metadata: {
        displayContent: "Check the pricing page",
        dispatchContent:
          'Use the existing "Pricing" page in the current shared browser session for this request.\n\nCheck the pricing page',
      },
    };
    for (const rawText of [PROXY_STREAMED_RATE_LIMIT, MISSING_FINAL_MESSAGE]) {
      expect(
        resolveRunFailureAutoRetryDelayMs({
          presentation: presentationFor(rawText),
          promptMessage: { content: "Check the pricing page", metadata },
        }),
        rawText,
      ).toBeNull();
    }
    expect(
      resolveRunFailureAutoRetryDelayMs({
        presentation: presentationFor(MISSING_FINAL_MESSAGE),
        promptMessage: {
          content: "Check the pricing page",
          metadata: { dispatchContent: "  Check the pricing page " },
        },
      }),
    ).toBe(0);
  });

  it("never resends a prompt that was itself a retry, so a retry never retries itself", () => {
    const content = "Build me a landing page";
    for (const rawText of [PROXY_STREAMED_RATE_LIMIT, MISSING_FINAL_MESSAGE, NO_WORKSPACE_CHANGES]) {
      for (const metadata of [
        { retryOfMessageId: "failure-1" },
        { prompt_metadata: { retryOfMessageId: "failure-1" } },
      ]) {
        expect(
          resolveRunFailureAutoRetryDelayMs({
            presentation: presentationFor(rawText),
            promptMessage: { content, metadata },
          }),
          `${rawText} ${JSON.stringify(metadata)}`,
        ).toBeNull();
      }
    }
  });

  it("never resends a prompt with attachments or a reply context as bare text", () => {
    const content = "What is wrong in this screenshot?";
    for (const metadata of [
      { prompt_metadata: { attachments: [{ path: ".instafy/uploads/shot.png", mimeType: "image/png" }] } },
      { replyContext: { messageId: "a-0", selectedText: "the red banner" } },
    ]) {
      expect(
        resolveRunFailureAutoRetryDelayMs({
          presentation: presentationFor(PROXY_STREAMED_RATE_LIMIT),
          promptMessage: { content, metadata },
        }),
        JSON.stringify(metadata),
      ).toBeNull();
    }
  });
});

describe("isRunFailurePromptAutoResendable", () => {
  it("is true for a plain prompt", () => {
    expect(isRunFailurePromptAutoResendable({ content: "Build me a landing page", metadata: null })).toBe(
      true,
    );
    expect(
      isRunFailurePromptAutoResendable({
        content: "Build me a landing page",
        metadata: { prompt_metadata: { attachments: [], replyContext: null } },
      }),
    ).toBe(true);
  });

  it("is false for a prompt that acts on another message, such as an undo request", () => {
    expect(
      isRunFailurePromptAutoResendable({
        content: "Undo the changes from message (id 1a2b3c4d)",
        metadata: { undoTargetMessageId: "1a2b3c4d-0000-4000-8000-000000000000" },
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "Undo the changes from message (id 1a2b3c4d)",
        metadata: { prompt_metadata: { undoTargetMessageId: "1a2b3c4d-0000-4000-8000-000000000000" } },
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "Build me a landing page",
        metadata: { undoTargetMessageId: "  " },
      }),
    ).toBe(true);
  });

  it("is false for a prompt with attachments, which a text-only resend would drop", () => {
    expect(
      isRunFailurePromptAutoResendable({
        content: "What is wrong in this screenshot?",
        metadata: { attachments: [{ path: ".instafy/uploads/shot.png", mimeType: "image/png" }] },
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "What is wrong in this screenshot?",
        metadata: {
          prompt_metadata: { attachments: [{ path: ".instafy/uploads/shot.png", mimeType: "image/png" }] },
        },
      }),
    ).toBe(false);
  });

  it("is false for a reply to a selected part of a message, which a resend would drop", () => {
    expect(
      isRunFailurePromptAutoResendable({
        content: "Make this shorter",
        metadata: { replyContext: { messageId: "m-1", selectedText: "the red banner" } },
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "Make this shorter",
        metadata: { prompt_metadata: { reply_context: { message_id: "m-1" } } },
      }),
    ).toBe(false);
  });

  it("is false for a browser-routed or rewritten prompt", () => {
    expect(
      isRunFailurePromptAutoResendable({
        content: "Open the site",
        metadata: { prompt_metadata: { browserTransport: "shared" } },
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "Open the site",
        metadata: { dispatchContent: "Open this request in a fresh browser page.\n\nOpen the site" },
      }),
    ).toBe(false);
  });
});

describe("isRunFailureRecentForAutoRetry", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");

  it("is true within ten minutes of now, on either side for a skewed clock", () => {
    expect(isRunFailureRecentForAutoRetry({ timestamp: now - 5_000 }, now)).toBe(true);
    expect(isRunFailureRecentForAutoRetry({ timestamp: now - RUN_FAILURE_AUTO_RETRY_MAX_AGE_MS }, now)).toBe(
      true,
    );
    expect(isRunFailureRecentForAutoRetry({ timestamp: now + 30_000 }, now)).toBe(true);
  });

  it("is false for an older failure, or one from far ahead", () => {
    expect(
      isRunFailureRecentForAutoRetry({ timestamp: now - RUN_FAILURE_AUTO_RETRY_MAX_AGE_MS - 1 }, now),
    ).toBe(false);
    expect(isRunFailureRecentForAutoRetry({ timestamp: now - 26 * 60 * 60 * 1000 }, now)).toBe(false);
    expect(isRunFailureRecentForAutoRetry({ timestamp: now + 11 * 60_000 }, now)).toBe(false);
  });

  it("is false without a usable timestamp", () => {
    expect(isRunFailureRecentForAutoRetry({ timestamp: 0 }, now)).toBe(false);
    expect(isRunFailureRecentForAutoRetry({ timestamp: Number.NaN }, now)).toBe(false);
    expect(isRunFailureRecentForAutoRetry({ timestamp: undefined as unknown as number }, now)).toBe(false);
  });
});

describe("isRunFailurePromptSharedWithOtherRuns", () => {
  const prompt = (metadata: Record<string, unknown> | null = null) =>
    createMessage({ id: "prompt", role: "user", content: "Update the copy and the styles", metadata });
  const failed = (metadata: Record<string, unknown>) =>
    createMessage({
      id: "failure",
      content: MISSING_FINAL_MESSAGE,
      metadata: { source: "agent", outcome: "failed", ...metadata },
    });

  it("is true for a prompt sent to several agents", () => {
    const source = prompt({ prompt_metadata: { agentSelection: { active: ["octo", "writer"], mentions: [] } } });
    const failure = failed({ jobId: "job-1" });
    expect(
      isRunFailurePromptSharedWithOtherRuns({
        conversationMessages: [source, failure],
        promptMessage: source,
        failureMessage: failure,
      }),
    ).toBe(true);
  });

  it("follows the mentions over the active agents, as the submit path does", () => {
    const source = prompt({ agentSelection: { active: ["octo", "writer"], mentions: ["@writer"] } });
    const failure = failed({ jobId: "job-1" });
    expect(
      isRunFailurePromptSharedWithOtherRuns({
        conversationMessages: [source, failure],
        promptMessage: source,
        failureMessage: failure,
      }),
    ).toBe(false);
  });

  it("is true when another run for the same prompt succeeded", () => {
    const source = prompt();
    const writerDone = createMessage({
      id: "writer-done",
      content: "Updated the copy.",
      metadata: { source: "agent", outcome: "succeeded", jobId: "job-a" },
    });
    const failure = failed({ jobId: "job-b" });
    expect(
      isRunFailurePromptSharedWithOtherRuns({
        conversationMessages: [source, writerDone, failure],
        promptMessage: source,
        failureMessage: failure,
      }),
    ).toBe(true);
  });

  it("is true when replies to the prompt came from more than one agent", () => {
    const source = prompt();
    const writerUpdate = createMessage({
      id: "writer-update",
      content: "Working on it.",
      metadata: { agent: { handle: "@Writer" } },
    });
    const failure = failed({ jobId: "job-b", agent_handle: "octo" });
    expect(
      isRunFailurePromptSharedWithOtherRuns({
        conversationMessages: [source, writerUpdate, failure],
        promptMessage: source,
        failureMessage: failure,
      }),
    ).toBe(true);
  });

  it("is false for one agent's run, and ignores replies to later prompts", () => {
    const source = prompt({ agentSelection: { active: ["octo"], mentions: [] } });
    const command = createMessage({
      id: "command",
      content: "npm run build",
      messageType: "command_execution",
      metadata: { status: "completed", outcome: "succeeded", jobId: "job-1", agentHandle: "octo" },
    });
    const failure = failed({ jobId: "job-1", agentHandle: "@octo" });
    const later = createMessage({ id: "later", role: "user", content: "Something else" });
    const laterDone = createMessage({
      id: "later-done",
      content: "Done.",
      metadata: { source: "agent", outcome: "succeeded", jobId: "job-2", agentHandle: "writer" },
    });
    expect(
      isRunFailurePromptSharedWithOtherRuns({
        conversationMessages: [source, command, failure, later, laterDone],
        promptMessage: source,
        failureMessage: failure,
      }),
    ).toBe(false);
  });
});

describe("readRunFailureRetryOf", () => {
  it("reads the retry link from the local or the stored prompt", () => {
    expect(readRunFailureRetryOf({ metadata: { retryOfMessageId: "failure-1" } })).toBe("failure-1");
    expect(readRunFailureRetryOf({ metadata: { prompt_metadata: { retryOfMessageId: "failure-2" } } })).toBe(
      "failure-2",
    );
    expect(readRunFailureRetryOf({ metadata: { clientMessageId: "c-1" } })).toBeNull();
    expect(readRunFailureRetryOf({ metadata: null })).toBeNull();
  });
});

describe("isRunFailureRetryQueued", () => {
  it("is true while a resend of the failure waits in a send queue", () => {
    const failureMessage = { id: "failure-1" };
    expect(
      isRunFailureRetryQueued({
        queuedSends: [{ metadata: null }, { metadata: { retryOfMessageId: "failure-1", agentSelection: {} } }],
        failureMessage,
      }),
    ).toBe(true);
    expect(
      isRunFailureRetryQueued({
        queuedSends: [{ metadata: { retryOfMessageId: "failure-0" } }, {}],
        failureMessage,
      }),
    ).toBe(false);
    expect(isRunFailureRetryQueued({ queuedSends: [], failureMessage })).toBe(false);
  });
});

describe("isRunFailurePromptFromThisClient", () => {
  const client = { sessionId: "session-1", userId: "user-1" };

  it("is true for a prompt this person sent from this tab", () => {
    expect(
      isRunFailurePromptFromThisClient({
        promptMessage: { authorId: "user-1", metadata: { prompt_metadata: { client } } },
        currentUserId: "user-1",
        chatClientSessionId: "session-1",
      }),
    ).toBe(true);
    // The local copy keeps the client at the top level until the controller stores it.
    expect(
      isRunFailurePromptFromThisClient({
        promptMessage: { authorId: null, metadata: { client } },
        currentUserId: "user-1",
        chatClientSessionId: "session-1",
      }),
    ).toBe(true);
  });

  it("is false for another person's prompt, another tab's, or one with no client session", () => {
    const fromThisTab = { prompt_metadata: { client } };
    expect(
      isRunFailurePromptFromThisClient({
        promptMessage: { authorId: "user-2", metadata: fromThisTab },
        currentUserId: "user-1",
        chatClientSessionId: "session-1",
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptFromThisClient({
        promptMessage: { authorId: "user-1", metadata: fromThisTab },
        currentUserId: "user-1",
        chatClientSessionId: "session-2",
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptFromThisClient({
        promptMessage: { authorId: "user-1", metadata: { prompt_metadata: { intent: "chat" } } },
        currentUserId: "user-1",
        chatClientSessionId: "session-1",
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptFromThisClient({
        promptMessage: { authorId: "user-1", metadata: fromThisTab },
        currentUserId: null,
        chatClientSessionId: "session-1",
      }),
    ).toBe(false);
  });
});

describe("isBrowserRoutedPromptMetadata", () => {
  it("reads browser routing where the controller stores a dispatched prompt's metadata", () => {
    expect(
      isBrowserRoutedPromptMetadata({
        intent: "chat",
        prompt_metadata: { browserTransport: "shared", browserPageId: "page-1" },
      }),
    ).toBe(true);
    expect(
      isBrowserRoutedPromptMetadata({ promptMetadata: { runtimeExpectations: { browserExecution: true } } }),
    ).toBe(true);
  });

  it("ignores prompts without browser routing", () => {
    expect(isBrowserRoutedPromptMetadata(null)).toBe(false);
    expect(isBrowserRoutedPromptMetadata({ replyContext: { messageId: "m-1" } })).toBe(false);
    expect(isBrowserRoutedPromptMetadata({ browserTransport: "  " })).toBe(false);
  });
});

describe("runFailureOriginKey", () => {
  it("normalizes whitespace and case", () => {
    expect(runFailureOriginKey("  Build   ME a\tLanding\nPage  ")).toBe("build me a landing page");
  });

  it("is stable for prompts that differ only by surrounding/interior whitespace and case", () => {
    expect(runFailureOriginKey("Build me a landing page")).toBe(
      runFailureOriginKey("  build me   a landing page "),
    );
  });

  it("returns an empty string for empty input", () => {
    expect(runFailureOriginKey("")).toBe("");
    expect(runFailureOriginKey("   \n\t ")).toBe("");
  });
});

describe("resolveRunFailurePresentation", () => {
  it("maps missing final messages to the provider-hiccup sentence", () => {
    const presentation = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", jobId: "job-1" },
      content: MISSING_FINAL_MESSAGE,
    });
    expect(presentation).toEqual({
      kind: "missing_final_message",
      friendlyText: "The reply didn't come through — this is usually a temporary provider hiccup.",
      rawText: MISSING_FINAL_MESSAGE,
    });
  });

  it("maps missing workspace changes to the file-changes sentence", () => {
    expect(
      resolveRunFailurePresentation({ content: NO_WORKSPACE_CHANGES, assumeFailed: true })
        ?.friendlyText,
    ).toBe("The file changes didn't come through.");
  });

  it("maps missing command/MCP observations to the verification sentence", () => {
    expect(
      resolveRunFailurePresentation({ content: MISSING_COMMAND_OBSERVATION, assumeFailed: true })
        ?.friendlyText,
    ).toBe("The run ended before it could verify its work.");
    expect(
      resolveRunFailurePresentation({ content: MISSING_MCP_TOOL, assumeFailed: true })
        ?.friendlyText,
    ).toBe("The run ended before it could verify its work.");
  });

  it("prefers the errorMessage metadata field over the message content", () => {
    const presentation = resolveRunFailurePresentation({
      metadata: {
        source: "agent",
        outcome: "failed",
        jobId: "job-1",
        errorMessage: NO_WORKSPACE_CHANGES,
      },
      content: "Run failed.",
    });
    expect(presentation?.kind).toBe("no_workspace_changes");
    expect(presentation?.rawText).toBe(NO_WORKSPACE_CHANGES);
  });

  it("surfaces the real reason inline for an unclassified failure, only with failed-run metadata", () => {
    const presentation = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", jobId: "job-1" },
      content: "Codex run timed out",
    });
    // #145: the actual reason belongs inline, not the uninformative canned sentence.
    expect(presentation?.kind).toBe("generic");
    expect(presentation?.friendlyText).toBe("Codex run timed out");
    expect(presentation?.rawText).toBe("Codex run timed out");
    // A generic failure still requires failed-run metadata; assumeFailed alone
    // must never rewrite ordinary assistant text.
    expect(
      resolveRunFailurePresentation({ content: "Codex run timed out", assumeFailed: true }),
    ).toBeNull();
  });

  it("shows the controller's runtime-limit give-up reason in full, with a manual retry only", () => {
    // Recorded by runtime/limit_waits.rs when a message waited out the
    // 30-minute window behind the team's hosted runtime limit.
    const reason =
      "This message didn't start: every cloud runtime in this team stayed busy for 30 minutes. Stop a runtime you aren't using, then send it again.";
    const presentation = resolveRunFailurePresentation({
      metadata: {
        source: "controller",
        kind: "runtime_limit_wait_expired",
        outcome: "failed",
        messageType: "error",
        jobId: "job-1",
        runId: "run-1",
        errorMessage: reason,
      },
      content: reason,
    });
    expect(presentation?.kind).toBe("generic");
    expect(presentation?.friendlyText).toBe(reason);
    // Retrying on its own would only queue behind the same limit again.
    expect(isAutoRetryEligibleFailureKind(presentation?.kind)).toBe(false);
  });

  it("shows a launch refusal that ended the runtime-limit wait in full, with a manual retry only", () => {
    // Recorded by runtime/limit_waits.rs when a background retry was refused
    // for a reason waiting cannot fix: the refusal's own message.
    const reason =
      "This team is out of credits for today, so a hosted machine can't start. Credits refill daily at 00:00 UTC — or upgrade the plan, or connect your own machine (free, no limits).";
    const presentation = resolveRunFailurePresentation({
      metadata: {
        source: "controller",
        kind: "runtime_limit_wait_refused",
        outcome: "failed",
        messageType: "error",
        jobId: "job-1",
        runId: "run-1",
        errorMessage: reason,
      },
      content: reason,
    });
    expect(presentation?.kind).toBe("generic");
    expect(presentation?.friendlyText).toBe(reason);
    expect(isAutoRetryEligibleFailureKind(presentation?.kind)).toBe(false);
  });

  describe("a turn a stop put back in the queue that no machine picked up in time", () => {
    // Recorded by the controller's requeue expiry (runtime/sweeps.rs).
    const reason =
      "This run was interrupted when its runtime stopped and was not resumed within 15 minutes. Send it again if you still need it.";
    const STOPPED_TEXT = "This turn was stopped and didn't pick up again in time. Try again to continue.";
    const LOST_MACHINE_TEXT = "This turn lost its machine and didn't pick up again in time. Try again to continue.";
    const presentationFor = (extra: Record<string, unknown>) =>
      resolveRunFailurePresentation({
        metadata: {
          source: "controller",
          kind: "interrupted_run_expired",
          outcome: "failed",
          messageType: "error",
          jobId: "job-1",
          runId: "run-1",
          errorMessage: reason,
          agent: { handle: "octo" },
          ...extra,
        },
        content: reason,
        assumeFailed: true,
      });

    it("says someone stopped it, with a manual retry only", () => {
      for (const interruptionReason of [
        "user_stop",
        "user_remove",
        "runtime_limit_takeover",
        "browser_session_runtime_limit_takeover",
      ]) {
        const presentation = presentationFor({ interruptionReason });
        expect(presentation, interruptionReason).toEqual({
          kind: "interrupted_run_expired",
          friendlyText: STOPPED_TEXT,
          rawText: reason,
        });
        expect(resolveRunFailureAutoRetryDelayMs({ presentation: presentation! })).toBeNull();
      }
    });

    it("says it lost its machine when nobody chose the stop, or the reason is unknown", () => {
      for (const interruptionReason of ["heartbeat_timeout", "credits_exhausted", "idle_stop", "other", "", 7, null]) {
        const presentation = presentationFor({ interruptionReason });
        expect(presentation?.kind).toBe("interrupted_run_expired");
        expect(presentation?.friendlyText, String(interruptionReason)).toBe(LOST_MACHINE_TEXT);
        expect(presentation?.rawText).toBe(reason);
      }
      expect(presentationFor({})?.friendlyText).toBe(LOST_MACHINE_TEXT);
    });

    it("keeps the controller's text for any other kind, and rewrites no ordinary message", () => {
      expect(presentationFor({ kind: "runtime_limit_wait_expired" })).toMatchObject({
        kind: "generic",
        friendlyText: reason,
      });
      expect(
        resolveRunFailurePresentation({
          metadata: { source: "controller", kind: "interrupted_run_expired" },
          content: reason,
        }),
      ).toBeNull();
    });
  });

  it("explains a model provider rate limit in plain words instead of the Codex text", () => {
    // The job failure the controller stores after the provider answered 429.
    const presentation = resolveRunFailurePresentation({
      metadata: {
        source: "agent",
        outcome: "failed",
        messageType: "error",
        jobId: "job-1",
        errorMessage: PROVIDER_RATE_LIMITED,
      },
      content: PROVIDER_RATE_LIMITED,
      assumeFailed: true,
    });
    expect(presentation).toEqual({
      kind: "provider_rate_limited",
      friendlyText: PROVIDER_RATE_LIMITED_TEXT,
      rawText: PROVIDER_RATE_LIMITED,
    });
    // The Studio cannot tell a short throttle from a spent plan window, so the
    // copy must not promise that a retry soon will work.
    expect(presentation?.friendlyText).not.toMatch(/in a minute/i);
  });

  it("says why the provider stopped an answer early instead of the Codex text", () => {
    const failed = (content: string) =>
      resolveRunFailurePresentation({
        metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: "job-1" },
        content,
      });
    expect(failed(RESPONSE_INCOMPLETE("max_output_tokens"))).toEqual({
      kind: "response_incomplete",
      friendlyText:
        "The answer hit the model's length limit before it was finished, so this turn stopped. Try asking for less at once, or split the request into smaller steps.",
      rawText: RESPONSE_INCOMPLETE("max_output_tokens"),
    });
    expect(failed(RESPONSE_INCOMPLETE("content_filter"))?.friendlyText).toBe(
      "The AI provider's content filter stopped this answer before it was finished, so this turn stopped. Try rephrasing the request.",
    );
    // A reason the copy does not name, or none, still reads as a stopped answer.
    for (const reason of ["unknown", "interrupted", ""]) {
      expect(failed(RESPONSE_INCOMPLETE(reason))?.friendlyText).toBe(
        "The AI provider stopped the answer before it was finished, so this turn stopped. Try again, or ask for less at once.",
      );
    }
    // The error bubble opts in with assumeFailed when the metadata lacks an outcome.
    expect(
      resolveRunFailurePresentation({
        content: RESPONSE_INCOMPLETE("content_filter"),
        assumeFailed: true,
      })?.kind,
    ).toBe("response_incomplete");
  });

  it("explains a browser task without a page in plain words instead of the runtime text", () => {
    for (const rawText of [BROWSER_PAGE_MISSING, BROWSER_PAGE_MISSING_FOR_MCP, BROWSER_PAGE_INVALID]) {
      const presentation = resolveRunFailurePresentation({
        metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: "job-1" },
        content: rawText,
      });
      // The raw text stays available behind Details.
      expect(presentation).toEqual({
        kind: "browser_page_missing",
        friendlyText: BROWSER_PAGE_MISSING_TEXT,
        rawText,
      });
      expect(presentation?.friendlyText).not.toMatch(/browserPageId|Shared Browser|UI-selected|CDP/);
      expect(presentation?.friendlyText).not.toContain("\u2014");
      expect(isAutoRetryEligibleFailureKind(presentation?.kind)).toBe(false);
    }
    // The error bubble opts in with assumeFailed when the metadata lacks an outcome.
    expect(
      resolveRunFailurePresentation({ content: BROWSER_PAGE_MISSING, assumeFailed: true })?.kind,
    ).toBe("browser_page_missing");
  });

  it("keeps the raw quota reason for a 429 that names an exhausted quota or plan limit", () => {
    for (const rawText of [PROVIDER_INSUFFICIENT_QUOTA, PROVIDER_USAGE_LIMIT_REACHED]) {
      // A standalone error bubble has no quota guard of its own, so the
      // classifier must not hide the quota type behind the rate limit copy.
      const presentation = resolveRunFailurePresentation({
        metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: "job-1" },
        content: rawText,
        assumeFailed: true,
      });
      expect(presentation).toEqual({ kind: "generic", friendlyText: rawText, rawText });
    }
  });

  it("keeps the inline generic reason to the first line and bounds its length", () => {
    const longFirstLine = `Boot failed: ${"x".repeat(400)}`;
    const presentation = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", jobId: "job-1" },
      content: `${longFirstLine}\nstack frame 1\nstack frame 2`,
    });
    expect(presentation?.friendlyText.length).toBeLessThanOrEqual(240);
    expect(presentation?.friendlyText.endsWith("…")).toBe(true);
    // The full multi-line text stays available (Details disclosure renders rawText).
    expect(presentation?.rawText).toContain("stack frame 2");
  });

  it("returns null without a failure signal or content", () => {
    expect(resolveRunFailurePresentation({ content: MISSING_FINAL_MESSAGE })).toBeNull();
    expect(
      resolveRunFailurePresentation({
        metadata: { source: "agent", outcome: "failed", jobId: "job-1" },
        content: "   ",
      }),
    ).toBeNull();
  });
});

describe("resolveRetryingStatusPresentation", () => {
  it("maps Retrying-prefixed status lines and keeps the raw line", () => {
    const raw =
      "Retrying: the latest request requires workspace file changes, but the Codex reply produced no files.";
    expect(resolveRetryingStatusPresentation({ content: raw })).toEqual({
      displayText: RETRYING_STATUS_DISPLAY_TEXT,
      fullText: raw,
    });
  });

  it("maps codex_retry status metadata regardless of wording", () => {
    const raw = "Finishing response from saved workspace context.";
    expect(
      resolveRetryingStatusPresentation({
        metadata: { kind: "codex_retry", reason: "missing_final", attempt: 2 },
        content: raw,
      }),
    ).toEqual({ displayText: RETRYING_STATUS_DISPLAY_TEXT, fullText: raw });
  });

  it("maps codex_stream_retry status metadata regardless of wording", () => {
    const raw = "stream disconnected before completion: 429 Too Many Requests";
    expect(
      resolveRetryingStatusPresentation({
        metadata: { kind: "codex_stream_retry", event: { type: "stream.retry" } },
        content: raw,
      }),
    ).toEqual({ displayText: RETRYING_STATUS_DISPLAY_TEXT, fullText: raw });
  });

  it("ignores ordinary status lines", () => {
    expect(resolveRetryingStatusPresentation({ content: "Running tests now." })).toBeNull();
    expect(resolveRetryingStatusPresentation({ content: "Retrying the tests now." })).toBeNull();
  });
});

describe("resolveRunFailureRetryPrompt", () => {
  const conversationMessages: ChatMessage[] = [
    createMessage({ id: "user-1", role: "user", content: "Build me a landing page", timestamp: 10 }),
    createMessage({ id: "assistant-1", content: "Starting run…", timestamp: 20 }),
    createMessage({
      id: "failure-1",
      content: MISSING_FINAL_MESSAGE,
      timestamp: 30,
      metadata: { source: "agent", outcome: "failed", jobId: "job-1" },
    }),
    createMessage({ id: "user-2", role: "user", content: "Try a darker theme", timestamp: 40 }),
  ];

  it("returns the nearest user message preceding the failure message", () => {
    expect(
      resolveRunFailureRetryPrompt({
        conversationMessages,
        failureMessage: conversationMessages[2],
      }),
    ).toBe("Build me a landing page");
  });

  it("locates synthesized terminal messages by timestamp", () => {
    expect(
      resolveRunFailureRetryPrompt({
        conversationMessages,
        failureMessage: { id: "thread-preview-terminal:run-1", timestamp: 35 },
      }),
    ).toBe("Build me a landing page");
  });

  it("does not resend prompts sent after the failure", () => {
    expect(
      resolveRunFailureRetryPrompt({
        conversationMessages,
        failureMessage: { id: "unknown", timestamp: 15 },
      }),
    ).toBe("Build me a landing page");
  });

  it("falls back to the latest user message when the failure cannot be located", () => {
    expect(
      resolveRunFailureRetryPrompt({
        conversationMessages,
        failureMessage: { id: "unknown", timestamp: Number.NaN },
      }),
    ).toBe("Try a darker theme");
  });

  it("returns null when no user prompt exists", () => {
    expect(
      resolveRunFailureRetryPrompt({
        conversationMessages: [createMessage({ id: "assistant-only", content: "Hello" })],
        failureMessage: { id: "assistant-only", timestamp: 0 },
      }),
    ).toBeNull();
  });
});

describe("resolveRunFailureRetrySource", () => {
  it("returns the user message that started the failed run", () => {
    const prompt = createMessage({
      id: "user-1",
      role: "user",
      content: "Open the pricing page",
      timestamp: 10,
      metadata: { browserTransport: "shared" },
    });
    const failure = createMessage({ id: "failure-1", content: PROVIDER_RATE_LIMITED, timestamp: 20 });
    expect(
      resolveRunFailureRetrySource({ conversationMessages: [prompt, failure], failureMessage: failure }),
    ).toBe(prompt);
  });

  // The pricing page started run-1. While it ran, someone wrote a note to a
  // teammate that group participation only recorded (no run), then run-1 failed.
  const pricing = createMessage({
    id: "user-1",
    role: "user",
    content: "Build the pricing page",
    timestamp: 10,
    metadata: { runId: "run-1", prompt_metadata: { clientMessageId: "client-1" } },
  });
  const note = createMessage({
    id: "user-2",
    role: "user",
    content: "Sam, the staging link is in the doc",
    timestamp: 20,
    metadata: { prompt_metadata: { groupParticipation: { decision: "silent" } } },
  });

  it("returns the prompt whose stored copy names the failed run, not a note sent while it ran", () => {
    for (const failureMetadata of [
      { source: "agent", outcome: "failed", jobId: "job-1", runId: "run-1" },
      { source: "agent", outcome: "failed", run_id: "run-1" },
    ]) {
      const failure = createMessage({
        id: "failure-1",
        content: PROXY_STREAMED_RATE_LIMIT,
        timestamp: 30,
        metadata: failureMetadata,
      });
      const conversationMessages = [pricing, note, failure];
      expect(resolveRunFailureRetrySource({ conversationMessages, failureMessage: failure })).toBe(pricing);
      expect(resolveRunFailureRetryPrompt({ conversationMessages, failureMessage: failure })).toBe(
        "Build the pricing page",
      );
      // A run-record card that is not in the list is placed by its timestamp.
      expect(
        resolveRunFailureRetrySource({
          conversationMessages: [pricing, note],
          failureMessage: { id: "thread-preview-terminal:run-1", timestamp: 30, metadata: failureMetadata },
        }),
      ).toBe(pricing);
    }
  });

  it("falls back to the nearest prompt when no prompt names the failed run", () => {
    const failure = createMessage({
      id: "failure-1",
      content: PROXY_STREAMED_RATE_LIMIT,
      timestamp: 30,
      metadata: { source: "agent", outcome: "failed", jobId: "job-9", runId: "run-9" },
    });
    const localPricing = createMessage({ ...pricing, metadata: { clientMessageId: "client-1" } });
    for (const conversationMessages of [
      [pricing, note, failure],
      [localPricing, note, failure],
    ]) {
      expect(resolveRunFailureRetrySource({ conversationMessages, failureMessage: failure })).toBe(note);
    }
  });

  // The controller stores a steer sent into run-1 with run-1's id and the
  // steered job in its send intent.
  const steer = createMessage({
    id: "user-steer",
    role: "user",
    content: "Also make the header blue",
    timestamp: 20,
    metadata: {
      runId: "run-1",
      clientMessageId: "client-steer",
      sendIntent: { mode: "steer", jobId: "job-1", state: "applied" },
    },
  });
  const runOneFailure = createMessage({
    id: "failure-1",
    content: PROXY_STREAMED_RATE_LIMIT,
    timestamp: 30,
    metadata: { source: "agent", outcome: "failed", jobId: "job-1", runId: "run-1" },
  });

  it("returns the prompt that started a steered run, not the steer sent into it", () => {
    const conversationMessages = [pricing, steer, runOneFailure];
    expect(resolveRunFailureRetrySource({ conversationMessages, failureMessage: runOneFailure })).toBe(
      pricing,
    );
    expect(resolveRunFailureRetryPrompt({ conversationMessages, failureMessage: runOneFailure })).toBe(
      "Build the pricing page",
    );
  });

  it("skips a steer when the prompt's stored copy has not arrived", () => {
    const localPricing = createMessage({ ...pricing, metadata: { clientMessageId: "client-1" } });
    expect(
      resolveRunFailureRetrySource({
        conversationMessages: [localPricing, steer, runOneFailure],
        failureMessage: runOneFailure,
      }),
    ).toBe(localPricing);
  });

  it("takes the first prompt that names the run, which is the one that started it", () => {
    // A later row naming the same run without a send intent.
    const laterRow = createMessage({ ...note, id: "user-3", timestamp: 25, metadata: { runId: "run-1" } });
    expect(
      resolveRunFailureRetrySource({
        conversationMessages: [pricing, laterRow, runOneFailure],
        failureMessage: runOneFailure,
      }),
    ).toBe(pricing);
  });

  it("knows a run someone steered, by its run or its job", () => {
    expect(
      isRunFailureRunSteered({
        conversationMessages: [pricing, steer, runOneFailure],
        failureMessage: runOneFailure,
      }),
    ).toBe(true);
    const steerByJobOnly = createMessage({
      ...steer,
      metadata: { sendIntent: { mode: "steer", jobId: "job-1" } },
    });
    expect(
      isRunFailureRunSteered({
        conversationMessages: [pricing, steerByJobOnly, runOneFailure],
        failureMessage: runOneFailure,
      }),
    ).toBe(true);
    // No steer, or a steer into another run.
    expect(
      isRunFailureRunSteered({ conversationMessages: [pricing, note, runOneFailure], failureMessage: runOneFailure }),
    ).toBe(false);
    const otherRunFailure = createMessage({
      ...runOneFailure,
      metadata: { source: "agent", outcome: "failed", jobId: "job-2", runId: "run-2" },
    });
    expect(
      isRunFailureRunSteered({
        conversationMessages: [pricing, steer, otherRunFailure],
        failureMessage: otherRunFailure,
      }),
    ).toBe(false);
  });

  it("never matches a prompt by a run it names after the failure", () => {
    const failure = createMessage({
      id: "failure-1",
      content: PROXY_STREAMED_RATE_LIMIT,
      timestamp: 15,
      metadata: { source: "agent", outcome: "failed", runId: "run-2" },
    });
    const later = createMessage({ ...note, id: "user-3", timestamp: 40, metadata: { runId: "run-2" } });
    expect(
      resolveRunFailureRetrySource({ conversationMessages: [pricing, failure, later], failureMessage: failure }),
    ).toBe(pricing);
  });
});

describe("readRunFailureRunIds", () => {
  it("reads the job and run a failed run's message names", () => {
    expect(readRunFailureRunIds({ metadata: { jobId: "job-1", runId: "run-1" } })).toEqual([
      "job-1",
      "run-1",
    ]);
    expect(readRunFailureRunIds({ metadata: { job_id: " job-2 ", run_id: "" } })).toEqual(["job-2"]);
    expect(readRunFailureRunIds({ metadata: null })).toEqual([]);
    expect(readRunFailureRunIds({})).toEqual([]);
  });
});

describe("isRunFailureRetrySuperseded", () => {
  const prompt = createMessage({ id: "user-1", role: "user", content: "Build me a landing page", timestamp: 10 });
  const failure = createMessage({
    id: "failure-1",
    content: PROVIDER_RATE_LIMITED,
    timestamp: 20,
    metadata: { source: "agent", outcome: "failed", jobId: "job-1" },
  });

  it("is false while nothing was sent after the failure", () => {
    expect(
      isRunFailureRetrySuperseded({ conversationMessages: [prompt, failure], failureMessage: failure }),
    ).toBe(false);
  });

  it("is true once a resend names the failure in its metadata", () => {
    expect(buildRunFailureRetryMetadata(failure)).toEqual({
      [RUN_FAILURE_RETRY_OF_METADATA_KEY]: "failure-1",
    });
    const resend = createMessage({
      id: "user-2",
      role: "user",
      content: "Build me a landing page",
      timestamp: 30,
      metadata: buildRunFailureRetryMetadata(failure),
    });
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, failure, resend],
        failureMessage: failure,
      }),
    ).toBe(true);
  });

  it("finds the link where the controller stores a dispatched prompt's metadata", () => {
    // Loaded after a reload, with text the fallback below would not match.
    const stored = createMessage({
      id: "user-2",
      role: "user",
      content: "Build me a landing page, please",
      timestamp: 30,
      metadata: {
        intent: "chat",
        prompt_metadata: { retryOfMessageId: "failure-1", writeIntent: true },
      },
    });
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, failure, stored],
        failureMessage: failure,
      }),
    ).toBe(true);
    const otherFailure = { id: "failure-other", timestamp: 25 };
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, failure, stored],
        failureMessage: otherFailure,
      }),
    ).toBe(false);
  });

  it("recognizes an older resend without the link by its text after the failure", () => {
    // Retries sent before the metadata link existed resent the same text.
    const resend = createMessage({
      id: "user-2",
      role: "user",
      content: "  build me a   landing page ",
      timestamp: 30,
    });
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, failure, resend],
        failureMessage: failure,
      }),
    ).toBe(true);
    // A different follow-up does not retire the card.
    const followUp = createMessage({ id: "user-3", role: "user", content: "Try a darker theme", timestamp: 30 });
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, failure, followUp],
        failureMessage: failure,
      }),
    ).toBe(false);
  });

  it("does not count a resend that never went out", () => {
    // Its dispatch failed: the local copy keeps the link and the text.
    const unsent = createMessage({
      id: "user-2",
      role: "user",
      content: "Build me a landing page",
      timestamp: 30,
      metadata: buildRunFailureRetryMetadata(failure),
    });
    const conversationMessages = [prompt, failure, unsent];
    expect(isRunFailureRetrySuperseded({ conversationMessages, failureMessage: failure })).toBe(true);
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages,
        failureMessage: failure,
        isUnsent: (message) => message.id === "user-2",
      }),
    ).toBe(false);
  });

  it("leaves the failure of the resend itself retryable", () => {
    const resend = createMessage({
      id: "user-2",
      role: "user",
      content: "Build me a landing page",
      timestamp: 30,
      metadata: buildRunFailureRetryMetadata(failure),
    });
    const secondFailure = createMessage({
      id: "failure-2",
      content: PROVIDER_RATE_LIMITED,
      timestamp: 40,
      metadata: { source: "agent", outcome: "failed", jobId: "job-2" },
    });
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, failure, resend, secondFailure],
        failureMessage: secondFailure,
      }),
    ).toBe(false);
  });

  it("places a synthesized terminal failure by its timestamp", () => {
    const resend = createMessage({ id: "user-2", role: "user", content: "Build me a landing page", timestamp: 30 });
    const synthesized = { id: "thread-preview-terminal:run-1", timestamp: 20 };
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, resend],
        failureMessage: synthesized,
      }),
    ).toBe(true);
    // A failure that cannot be placed has nothing after it.
    expect(
      isRunFailureRetrySuperseded({
        conversationMessages: [prompt, resend],
        failureMessage: { id: "unknown", timestamp: Number.NaN },
      }),
    ).toBe(false);
  });
});
