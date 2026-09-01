import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";
import {
  RETRYING_STATUS_DISPLAY_TEXT,
  classifyRunFailureText,
  hasFailedRunMetadata,
  isAutoRetryEligibleFailureKind,
  resolveRetryingStatusPresentation,
  resolveRunFailurePresentation,
  resolveRunFailureRetryPrompt,
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

  it("returns null for unrelated text", () => {
    expect(classifyRunFailureText("Codex run timed out")).toBeNull();
    expect(classifyRunFailureText("All tests pass.")).toBeNull();
  });
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
  it("is true for the two transient kinds", () => {
    expect(isAutoRetryEligibleFailureKind("missing_final_message")).toBe(true);
    expect(isAutoRetryEligibleFailureKind("no_workspace_changes")).toBe(true);
  });

  it("is false for deterministic/unhelpful kinds and nullish input", () => {
    expect(isAutoRetryEligibleFailureKind("missing_verification")).toBe(false);
    expect(isAutoRetryEligibleFailureKind("needs_ai")).toBe(false);
    expect(isAutoRetryEligibleFailureKind("generic")).toBe(false);
    expect(isAutoRetryEligibleFailureKind(null)).toBe(false);
    expect(isAutoRetryEligibleFailureKind(undefined)).toBe(false);
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
