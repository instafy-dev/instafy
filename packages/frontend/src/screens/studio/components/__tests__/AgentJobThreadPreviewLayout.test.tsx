// @vitest-environment jsdom

import { act, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelAgentJob } from "../../../../services/runtimeController/jobs";
import type { ChatMessage } from "../../types";
import {
  AgentJobThreadPreviewLayout,
  type AgentJobThreadPreviewLayoutProps,
} from "../AgentJobThreadPreviewLayout";
import { RunFailureRetryProvider } from "../RunFailureNotice";

const JOB_ID = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";

vi.mock("../../../../services/runtimeController/jobs", () => ({
  cancelAgentJob: vi.fn(() =>
    Promise.resolve({ ok: true, canceledRunIds: ["run-1"], canceledJobIds: ["job-1"] }),
  ),
  cancelPlanGroup: vi.fn(() =>
    Promise.resolve({ ok: true, canceledRunIds: ["run-1"], canceledJobIds: ["job-1"] }),
  ),
}));

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "agent-job-thread",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: "agent_job_thread",
    metadata: {
      messageType: "agent_job_thread",
      jobId: JOB_ID,
      threadLocalId: "thread-local",
      agent: { handle: "octo" },
      advisoryScopeClaims: [{ label: "Investigate auth middleware" }],
    },
    ...overrides,
  };
}

function MessageContent({ content }: { content: string }) {
  return <span>{content}</span>;
}

function ChatFileChangeList() {
  return <div data-testid="mock-file-change-list" />;
}

function createLongSummaryMessage(): ChatMessage {
  return createMessage({
    id: "long-summary",
    content: "Detailed run summary. ".repeat(40),
  });
}

const CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR = `unexpected status 401 Unauthorized: controller credential fetch failed: controller credentials returned 500 Internal Server Error: {
  "message": "Codex OAuth refresh failed: Your refresh token has already been used to generate a new access token. Please try signing in again."
}`;

const CONTROLLER_CREDENTIAL_REFRESH_INVALID_ERROR =
  'unexpected status 401 Unauthorized: controller credential fetch failed: controller credentials returned 500 Internal Server Error: {"message":"Codex OAuth refresh failed: Could not validate your refresh token. Please try signing in again."}, url: http://proxy:8789/v1/responses';

function createProps(
  overrides: Partial<AgentJobThreadPreviewLayoutProps> = {},
): AgentJobThreadPreviewLayoutProps {
  return {
    message: createMessage(),
    projectId: "project-1",
    branchThreads: [],
    showHeaderAvatar: true,
    assistantAvatarMotion: "idle",
    hiddenUpdateCount: 0,
    isHybridCompactionActive: false,
    isThreadPreviewExpanded: false,
    visibleCompactEvents: [],
    overflowCompactCount: 0,
    latestCompactEventId: null,
    showCompactRailWaitingSpinner: false,
    isThreadUnresolved: false,
    singleCompactEvent: null,
    singleCompactEventLabel: "",
    showSingleCompactEventStatusSweep: false,
    canCancelTerminalRun: false,
    cancelPending: false,
    compactRailStatusText: "",
    shouldSweepCompactRailStatusText: false,
    showCollapsedCompactRailStatus: false,
    showLiveCommandOutput: false,
    showLiveCommandPlaceholder: false,
    showCollapsedCommandToggle: false,
    showCollapsedCommandOutput: false,
    latestCommandExecution: null,
    latestCommandAgentHandle: null,
    latestCommandPreview: "",
    updatesForInlineRendering: [],
    expandedUpdateIds: {},
    finalSummaryMessage: createMessage({ id: "summary", content: "Finished." }),
    hasPreview: true,
    previewText: "Finished.",
    showSummaryBody: true,
    suppressSummaryRunningStatus: false,
    isCompleted: true,
    showRunningSpinnerFallback: false,
    shouldAnimateThreadLiveState: false,
    runningStatusLabel: null,
    useCompactRunningPreview: false,
            runningPreviewHasOverflow: false,
    latestFiles: null,
    isRunning: false,
    finalSpineTone: "primary",
    threadPreviewRootRef: { current: null },
    threadPreviewRef: { current: null },
    runningPreviewContainerRef: { current: null },
    threadPreviewRootStyle: {
      "--thread-spine-left": "-26px",
      "--thread-header-left": "-42px",
    } as CSSProperties,
    threadPreviewRailStyle: { top: "32px", bottom: "40px" },
    threadSpineJunctionOffsetClass: "left-[var(--thread-spine-left)]",
    threadSpineHeaderOffsetClass: "left-[var(--thread-header-left)]",
    summaryBodyPaddingTopClass: "pt-1",
    onOpenBranchThread: vi.fn(),
    onExpandThreadPreview: vi.fn(),
    onCollapseThreadPreview: vi.fn(),
    onToggleThreadPreview: vi.fn(),
    onToggleCommandOutput: vi.fn(),
    onToggleUpdateExpanded: vi.fn(),
    onCancelRun: vi.fn(),
    onCancelTerminalCommand: null,
    MessageContent,
    ChatFileChangeList,
    ...overrides,
  };
}

describe("AgentJobThreadPreviewLayout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(cancelAgentJob).mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders owner identity without the prompt or scope summary chip", async () => {
    await act(async () => {
      root.render(<AgentJobThreadPreviewLayout {...createProps()} />);
    });

    expect(container.querySelector('[data-testid="agent-thread-owner-badge"]')?.textContent).toBe("@octo");
    expect(container.querySelector('[data-testid="agent-thread-scope-badge"]')).toBeNull();
    expect(container.textContent).not.toContain("Investigate auth middleware");
  });

  it("animates the canonical header avatar only when active work requests motion", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({ assistantAvatarMotion: "thinking" })}
        />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="agent-job-thread-avatar"] [data-octo-motion="thinking"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout {...createProps({ assistantAvatarMotion: "idle" })} />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="agent-job-thread-avatar"] [data-octo-motion="idle"]',
      ),
    ).not.toBeNull();
  });

  it("renders compact rail events from another agent as an actor marker", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isHybridCompactionActive: true,
            visibleCompactEvents: [{ id: "ben-reply", kind: "thinking", actorHandle: "@ben" }],
            latestCompactEventId: "ben-reply",
            finalSummaryMessage: createLongSummaryMessage(),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-compact-actor"]')?.textContent).toBe("B");
    expect(container.querySelector('[aria-label="@ben replied"]')).not.toBeNull();
  });

  it("keeps compact overflow counts out of transcript text", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            overflowCompactCount: 7,
            visibleCompactEvents: [{ id: "latest", kind: "thinking", actorHandle: "@octo" }],
            latestCompactEventId: "latest",
            finalSummaryMessage: createLongSummaryMessage(),
          })}
        />,
      );
    });

    const indicator = container.querySelector(".instafy-compact-overflow-indicator") as HTMLElement | null;
    expect(indicator).not.toBeNull();
    expect(indicator?.dataset.count).toBe("7");
    expect(indicator?.getAttribute("aria-label")).toBe("7 earlier run updates");
    expect(indicator?.textContent).toBe("");
    expect(indicator?.className).not.toContain("after:bg-primary");
    expect(container.textContent).not.toContain("+7");
  });

  it("labels completed compact rail reasoning as history when the preview owner is unknown", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            message: createMessage({
              metadata: {
                messageType: "agent_job_thread",
                jobId: "run-1",
                  },
            }),
            isHybridCompactionActive: true,
            visibleCompactEvents: [{ id: "octo-reply", kind: "thinking", actorHandle: "@octo" }],
            latestCompactEventId: "octo-reply",
            finalSummaryMessage: createLongSummaryMessage(),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-compact-actor"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reasoning"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Thinking"]')).toBeNull();
  });

  it("keeps live compact rail reasoning labelled as thinking", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            message: createMessage({
              metadata: {
                messageType: "agent_job_thread",
                jobId: "run-1",
                  },
            }),
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            isHybridCompactionActive: true,
            visibleCompactEvents: [{ id: "octo-reasoning", kind: "thinking", actorHandle: "@octo" }],
            latestCompactEventId: "octo-reasoning",
            finalSummaryMessage: createMessage({ id: "empty-summary", content: "" }),
            showSummaryBody: false,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-compact-actor"]')).toBeNull();
    expect(container.querySelector('[aria-label="Thinking"]')).not.toBeNull();
  });

  it("labels live command status with the acting agent", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            message: createMessage({
              metadata: {
                messageType: "agent_job_thread",
                jobId: "run-1",
                  },
            }),
            showHeaderAvatar: false,
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            visibleCompactEvents: [{ id: "command", kind: "command", actorHandle: "@octo" }],
            latestCompactEventId: "command",
            showCollapsedCompactRailStatus: true,
            compactRailStatusText: "Running command…",
            latestCommandAgentHandle: "@octo",
            finalSummaryMessage: null,
            showSummaryBody: false,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-command-owner"]')?.textContent).toBe(
      "@octo",
    );
    expect(container.textContent).toContain("Running command…");
  });

  it("does not reserve an empty header above compact live command rows", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            message: createMessage({
              metadata: {
                messageType: "agent_job_thread",
                jobId: "run-1",
                  },
            }),
            showHeaderAvatar: false,
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            visibleCompactEvents: [{ id: "command", kind: "command", actorHandle: "@octo" }],
            latestCompactEventId: "command",
            showCollapsedCompactRailStatus: true,
            compactRailStatusText: "Running command…",
            latestCommandAgentHandle: "@octo",
            finalSummaryMessage: null,
            showSummaryBody: false,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-preview-header"]')).toBeNull();
  });

  it("cancels only the previewed job when the entry has a job id", async () => {
    const onCancelRun = vi.fn();
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            canCancelTerminalRun: true,
            showCollapsedCompactRailStatus: true,
            compactRailStatusText: "Running command…",
            finalSummaryMessage: null,
            showSummaryBody: false,
            onCancelRun,
          })}
        />,
      );
    });

    const stopButton = container.querySelector(
      '[data-testid="chat-command-stop-button"]',
    ) as HTMLButtonElement | null;
    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
    });

    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
    expect(cancelAgentJob).toHaveBeenCalledWith(JOB_ID, "Agent job cancelled by user");
    expect(onCancelRun).not.toHaveBeenCalled();
  });

  it("falls back to the conversation interrupt when the entry has no job id", async () => {
    const onCancelRun = vi.fn();
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            message: createMessage({
              metadata: {
                messageType: "agent_job_thread",
                threadLocalId: "thread-local",
                agent: { handle: "octo" },
              },
            }),
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            canCancelTerminalRun: true,
            showCollapsedCompactRailStatus: true,
            compactRailStatusText: "Running command…",
            finalSummaryMessage: null,
            showSummaryBody: false,
            onCancelRun,
          })}
        />,
      );
    });

    const stopButton = container.querySelector(
      '[data-testid="chat-command-stop-button"]',
    ) as HTMLButtonElement | null;
    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
    });

    expect(onCancelRun).toHaveBeenCalledTimes(1);
    expect(cancelAgentJob).not.toHaveBeenCalled();
  });

  async function renderCancelableRun(
    onCancelRun: () => void,
    messageOverrides?: Partial<ChatMessage>,
  ): Promise<HTMLButtonElement | null> {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            message: createMessage(messageOverrides),
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            canCancelTerminalRun: true,
            showCollapsedCompactRailStatus: true,
            compactRailStatusText: "Running command…",
            finalSummaryMessage: null,
            showSummaryBody: false,
            onCancelRun,
          })}
        />,
      );
    });
    return container.querySelector(
      '[data-testid="chat-command-stop-button"]',
    ) as HTMLButtonElement | null;
  }

  it("skips the per-job cancel when the extracted id is not a plausible job id", async () => {
    const onCancelRun = vi.fn();
    const stopButton = await renderCancelableRun(onCancelRun, {
      metadata: {
        messageType: "agent_job_thread",
        jobId: `thread:${JOB_ID}`,
        threadLocalId: "thread-local",
        agent: { handle: "octo" },
      },
    });

    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
    });

    expect(cancelAgentJob).not.toHaveBeenCalled();
    expect(onCancelRun).toHaveBeenCalledTimes(1);
  });

  it("falls back to the conversation interrupt when the per-job cancel throws", async () => {
    vi.mocked(cancelAgentJob).mockRejectedValueOnce(new Error("job cancel failed"));
    const onCancelRun = vi.fn();
    const stopButton = await renderCancelableRun(onCancelRun);

    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
    });

    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
    expect(onCancelRun).toHaveBeenCalledTimes(1);
    expect(stopButton?.disabled).toBe(false);
  });

  it("falls back to the conversation interrupt when the per-job cancel is unavailable", async () => {
    vi.mocked(cancelAgentJob).mockResolvedValueOnce(null);
    const onCancelRun = vi.fn();
    const stopButton = await renderCancelableRun(onCancelRun);

    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
    });

    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
    expect(onCancelRun).toHaveBeenCalledTimes(1);
    expect(stopButton?.disabled).toBe(false);
  });

  it("falls back to the conversation interrupt when the per-job cancel matches nothing", async () => {
    vi.mocked(cancelAgentJob).mockResolvedValueOnce({
      ok: true,
      canceledRunIds: [],
      canceledJobIds: [],
    });
    const onCancelRun = vi.fn();
    const stopButton = await renderCancelableRun(onCancelRun);

    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton?.click();
    });

    expect(cancelAgentJob).toHaveBeenCalledTimes(1);
    expect(onCancelRun).toHaveBeenCalledTimes(1);
    expect(stopButton?.disabled).toBe(false);
  });

  it("marks failed completed run traces with an explicit terminal status", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex completed without returning a final assistant message after retry.",
            }),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-terminal-status"]')?.textContent).toBe(
      "Run failed",
    );
    expect(container.textContent).toContain(
      "The reply didn't come through — this is usually a temporary provider hiccup.",
    );
    expect(container.textContent).not.toContain(
      "Codex completed without returning a final assistant message after retry.",
    );
    expect(container.querySelector('[data-testid="agent-thread-preview-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-spine"]')).toBeNull();
  });

  it("folds the terminal status into the preview header when the header renders", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            hiddenUpdateCount: 1,
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex completed without returning a final assistant message after retry.",
            }),
          })}
        />,
      );
    });

    const statusMarkers = container.querySelectorAll('[data-testid="agent-thread-terminal-status"]');
    expect(statusMarkers).toHaveLength(1);
    expect(statusMarkers[0]?.textContent).toBe("Run failed");
    expect(
      container
        .querySelector('[data-testid="agent-thread-preview-header"]')
        ?.querySelector('[data-testid="agent-thread-terminal-status"]'),
    ).not.toBeNull();
  });

  it("skips the duplicate status caption when the entry header already carries run status", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            runStatusShownInEntryHeader: true,
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex completed without returning a final assistant message after retry.",
            }),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-terminal-status"]')).toBeNull();
    expect(container.textContent).toContain(
      "The reply didn't come through — this is usually a temporary provider hiccup.",
    );
  });

  it("anchors the in-flight indicator at the newest end of the compact rail", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isCompleted: false,
            isThreadUnresolved: true,
            showCompactRailWaitingSpinner: true,
            showSummaryBody: false,
            hasPreview: false,
            previewText: "",
            finalSummaryMessage: null,
            visibleCompactEvents: [
              { id: "older", kind: "thinking", actorHandle: "@octo" },
              { id: "newest", kind: "command", actorHandle: "@octo" },
            ],
            latestCompactEventId: "newest",
          })}
        />,
      );
    });

    const pills = Array.from(container.querySelectorAll(".instafy-compact-event-pill"));
    expect(pills.length).toBe(3);
    const lastPill = pills[pills.length - 1];
    // The spinner pill sits at the newest (right) end and is the single live
    // indicator; older chips stay static so ordering is unambiguous (#176).
    expect(lastPill?.getAttribute("aria-label")).toBe("Run in progress");
    expect(lastPill?.classList.contains("instafy-compact-event-pill-live")).toBe(true);
    for (const pill of pills.slice(0, -1)) {
      expect(pill.classList.contains("instafy-compact-event-pill-live")).toBe(false);
    }
  });

  it("labels the in-flight pill as a starting run before any update chips exist", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isCompleted: false,
            isThreadUnresolved: true,
            showCompactRailWaitingSpinner: true,
            showSummaryBody: false,
            hasPreview: false,
            previewText: "",
            finalSummaryMessage: null,
            visibleCompactEvents: [],
            latestCompactEventId: null,
          })}
        />,
      );
    });

    const pills = Array.from(container.querySelectorAll(".instafy-compact-event-pill"));
    expect(pills.length).toBe(1);
    expect(pills[0]?.getAttribute("aria-label")).toBe("Starting run");
  });

  it("shows the step's hover card with header and excerpt when a rail chip gains focus", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isHybridCompactionActive: true,
            visibleCompactEvents: [
              {
                id: "cmd",
                kind: "command",
                actorHandle: "@octo",
                previewText: "pnpm --filter @instafy/frontend test:unit",
                previewMono: true,
              },
            ],
            latestCompactEventId: "cmd",
            finalSummaryMessage: createLongSummaryMessage(),
          })}
        />,
      );
    });

    const chip = container.querySelector<HTMLButtonElement>(".instafy-compact-event-pill");
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("BUTTON");
    // The card replaces the native tooltip on chips that carry an excerpt.
    expect(chip?.getAttribute("title")).toBeNull();

    await act(async () => {
      chip?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    const card = container.querySelector('[data-testid="agent-thread-compact-event-preview"]');
    expect(card).not.toBeNull();
    expect(
      card?.querySelector('[data-testid="agent-thread-compact-event-preview-header"]')?.textContent,
    ).toBe("Command");
    const body = card?.querySelector('[data-testid="agent-thread-compact-event-preview-body"]');
    expect(body?.textContent).toBe("pnpm --filter @instafy/frontend test:unit");
    expect(body?.querySelector(".font-mono")).not.toBeNull();

    await act(async () => {
      chip?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="agent-thread-compact-event-preview"]')).toBeNull();
  });

  it("shows the hover card after the hover delay on mouse hover", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(
          <AgentJobThreadPreviewLayout
            {...createProps({
              isHybridCompactionActive: true,
              visibleCompactEvents: [
                {
                  id: "search",
                  kind: "search",
                  actorHandle: "@octo",
                  previewText: "react hover card patterns",
                  previewMono: false,
                },
              ],
              latestCompactEventId: "search",
              finalSummaryMessage: createLongSummaryMessage(),
            })}
          />,
        );
      });

      const chip = container.querySelector<HTMLButtonElement>(".instafy-compact-event-pill");
      await act(async () => {
        chip?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      expect(container.querySelector('[data-testid="agent-thread-compact-event-preview"]')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(260);
      });
      const card = container.querySelector('[data-testid="agent-thread-compact-event-preview"]');
      expect(card).not.toBeNull();
      expect(
        card?.querySelector('[data-testid="agent-thread-compact-event-preview-header"]')?.textContent,
      ).toBe("Web search");
      expect(
        card?.querySelector('[data-testid="agent-thread-compact-event-preview-body"]')?.textContent,
      ).toBe("react hover card patterns");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the hover card and keeps the plain tooltip for chips without an excerpt", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isHybridCompactionActive: true,
            visibleCompactEvents: [{ id: "bare", kind: "thinking", actorHandle: "@octo" }],
            latestCompactEventId: "bare",
            finalSummaryMessage: createLongSummaryMessage(),
          })}
        />,
      );
    });

    const chip = container.querySelector<HTMLButtonElement>(".instafy-compact-event-pill");
    expect(chip?.getAttribute("title")).toBe("Reasoning");

    await act(async () => {
      chip?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="agent-thread-compact-event-preview"]')).toBeNull();
  });

  it("lists the elided steps' history labels on the overflow chip's card", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isHybridCompactionActive: true,
            overflowCompactCount: 3,
            overflowCompactEvents: [
              { id: "a", kind: "command", actorHandle: "@octo" },
              { id: "b", kind: "search", actorHandle: "@octo" },
              { id: "c", kind: "thinking", actorHandle: "@octo" },
            ],
            visibleCompactEvents: [{ id: "latest", kind: "tool", actorHandle: "@octo" }],
            latestCompactEventId: "latest",
            finalSummaryMessage: createLongSummaryMessage(),
          })}
        />,
      );
    });

    const overflowChip = container.querySelector<HTMLButtonElement>(".instafy-compact-overflow-indicator");
    expect(overflowChip).not.toBeNull();
    expect(overflowChip?.tagName).toBe("BUTTON");

    await act(async () => {
      overflowChip?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    const card = container.querySelector('[data-testid="agent-thread-compact-event-preview"]');
    expect(card).not.toBeNull();
    expect(
      card?.querySelector('[data-testid="agent-thread-compact-event-preview-header"]')?.textContent,
    ).toBe("3 earlier run updates");
    const lines = Array.from(
      card?.querySelectorAll('[data-testid="agent-thread-compact-event-preview-body"] .block.truncate') ?? [],
    ).map((line) => line.textContent);
    expect(lines).toEqual(["Command", "Web search", "Reasoning"]);
  });

  it("collapses the raw failure text behind the quiet details toggle", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex did not apply any workspace changes for a file-modifying request.",
              metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: JOB_ID },
            }),
          })}
        />,
      );
    });

    expect(container.textContent).toContain("The file changes didn't come through.");
    expect(container.querySelector('[data-testid="run-failure-details"]')).toBeNull();
    // Without a retry provider (read-only surfaces) the resend affordance stays hidden.
    expect(container.querySelector('[data-testid="run-failure-retry"]')).toBeNull();

    const detailsToggle = container.querySelector(
      '[data-testid="run-failure-details-toggle"]',
    ) as HTMLButtonElement | null;
    expect(detailsToggle).not.toBeNull();
    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      detailsToggle?.click();
    });

    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="run-failure-details"]')?.textContent).toBe(
      "Codex did not apply any workspace changes for a file-modifying request.",
    );

    await act(async () => {
      detailsToggle?.click();
    });
    expect(container.querySelector('[data-testid="run-failure-details"]')).toBeNull();
  });

  it("offers a quiet try-again pill that resends through the retry context", async () => {
    const requestRetry = vi.fn();
    const failureMessage = createMessage({
      id: "error-summary",
      content: "Codex completed without returning a final assistant message after retry.",
      metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: JOB_ID },
    });
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={{ pendingRetryKey: null, requestRetry, autoRetryingKey: null }}>
          <AgentJobThreadPreviewLayout
            {...createProps({
              finalSpineTone: "danger",
              finalSummaryMessage: failureMessage,
            })}
          />
        </RunFailureRetryProvider>,
      );
    });

    const retryButton = container.querySelector(
      '[data-testid="run-failure-retry"]',
    ) as HTMLButtonElement | null;
    expect(retryButton).not.toBeNull();
    expect(retryButton?.textContent).toBe("Try again");
    expect(retryButton?.disabled).toBe(false);
    await act(async () => {
      retryButton?.click();
    });
    expect(requestRetry).toHaveBeenCalledTimes(1);
    expect(requestRetry).toHaveBeenCalledWith(failureMessage);
  });

  it("disables try-again while a resend is in flight", async () => {
    const requestRetry = vi.fn();
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={{ pendingRetryKey: "error-summary", requestRetry, autoRetryingKey: null }}>
          <AgentJobThreadPreviewLayout
            {...createProps({
              finalSpineTone: "danger",
              finalSummaryMessage: createMessage({
                id: "error-summary",
                content: "Codex completed without returning a final assistant message after retry.",
                metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: JOB_ID },
              }),
            })}
          />
        </RunFailureRetryProvider>,
      );
    });

    const retryButton = container.querySelector(
      '[data-testid="run-failure-retry"]',
    ) as HTMLButtonElement | null;
    expect(retryButton?.disabled).toBe(true);
    await act(async () => {
      retryButton?.click();
    });
    expect(requestRetry).not.toHaveBeenCalled();
  });

  it("surfaces the real reason inline for a generic failed run (#145)", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex run hit an unexpected internal state.",
              metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: JOB_ID },
            }),
          })}
        />,
      );
    });

    // The uninformative canned sentence is gone; the actual failure reason is
    // shown inline instead of only behind Details.
    expect(container.textContent).toContain("Codex run hit an unexpected internal state.");
    expect(container.textContent).not.toContain("Something went wrong finishing this run.");
    // Status stays present as the entry-level header.
    expect(container.querySelector('[data-testid="agent-thread-terminal-status"]')?.textContent).toBe(
      "Run failed",
    );
  });

  it("keeps reconnect guidance for a terminal credential-refresh failure", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "credential-refresh-summary",
              content: CONTROLLER_CREDENTIAL_REFRESH_INVALID_ERROR,
              messageType: "error",
              metadata: {
                source: "agent",
                outcome: "failed",
                messageType: "error",
                jobId: JOB_ID,
              },
            }),
          })}
        />,
      );
    });

    expect(container.textContent).toContain(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
    expect(container.textContent).not.toContain("Something went wrong finishing this run.");
    expect(container.textContent).not.toContain("controller credential fetch failed");
  });

  it("softens interim retry status lines while keeping the raw line as a tooltip", async () => {
    const rawRetryLine =
      "Retrying: the latest request requires workspace file changes, but the Codex reply produced no files.";
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isCompleted: false,
            isRunning: true,
            isThreadUnresolved: true,
            finalSummaryMessage: null,
            showSummaryBody: false,
            updatesForInlineRendering: [
              createMessage({
                id: "retry-status",
                content: rawRetryLine,
                messageType: "status",
                metadata: {
                  messageType: "status",
                  kind: "codex_retry",
                  reason: "no_file_changes",
                  attempt: 2,
                },
              }),
            ],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Taking another pass…");
    expect(container.textContent).not.toContain(rawRetryLine);
    expect(container.querySelector(`[title="${rawRetryLine}"]`)).not.toBeNull();
  });

  it("keeps actionable proxy guidance when a final summary replaces the raw failure", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "friendly-proxy-summary",
              content: "The upstream provider rejected the AI request. Retry later or switch credentials.",
            }),
            updatesForInlineRendering: [
              createMessage({
                id: "raw-proxy-error",
                content: "Upstream 429 rejected the AI request (insufficient_quota).",
                messageType: "error",
                metadata: { messageType: "error", outcome: "failed" },
              }),
            ],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Run failed");
    expect(container.textContent).toContain("Upstream 429 rejected the AI request (insufficient_quota).");
    expect(container.textContent).not.toContain(
      "The upstream provider rejected the AI request. Retry later or switch credentials.",
    );
    expect(container.querySelector('[data-testid="agent-thread-preview-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-spine"]')).toBeNull();
  });

  it("does not reserve header space for hidden proxy failure updates", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            hiddenUpdateCount: 2,
            finalSummaryMessage: createMessage({
              id: "friendly-proxy-summary",
              content: "The upstream provider rejected the AI request. Retry later or switch credentials.",
            }),
            updatesForInlineRendering: [],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Run failed");
    expect(container.textContent).toContain(
      "The upstream provider rejected the AI request. Retry later or switch credentials.",
    );
    expect(container.querySelector('[data-testid="agent-thread-preview-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-spine"]')).toBeNull();
    expect(container.textContent).not.toContain("earlier update");
  });

  it("summarizes proxy credential diagnostics inside run-thread activity", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: null,
            previewText: "",
            showSummaryBody: false,
            updatesForInlineRendering: [
              createMessage({
                id: "credential-error",
                content: CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR,
                messageType: "error",
                metadata: { messageType: "error", outcome: "failed" },
              }),
            ],
          })}
        />,
      );
    });

    expect(container.textContent).toContain(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
    expect(container.textContent).not.toContain("controller credential fetch failed");
  });

  it("deduplicates repeated friendly proxy diagnostics and centers the update affordance", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "timeout-summary",
              content: "Codex run timed out",
            }),
            updatesForInlineRendering: [
              createMessage({
                id: "credential-error-1",
                content: CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR,
                messageType: "error",
                metadata: { messageType: "error", outcome: "failed" },
              }),
              createMessage({
                id: "credential-error-2",
                content: CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR,
                messageType: "error",
                metadata: { messageType: "error", outcome: "failed" },
              }),
            ],
          })}
        />,
      );
    });

    const renderedText = container.textContent ?? "";
    const summary = "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.";
    expect(renderedText.split(summary)).toHaveLength(2);
    expect(renderedText).toContain("Codex run timed out");
    expect(container.querySelector('[data-testid="agent-thread-inline-update-row"]')?.className).toContain(
      "items-center",
    );
  });

  it("does not duplicate summarized proxy credential diagnostics when final summary matches", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "credential-summary",
              content: CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR,
            }),
            updatesForInlineRendering: [
              createMessage({
                id: "credential-error",
                content: CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR,
                messageType: "error",
                metadata: { messageType: "error", outcome: "failed" },
              }),
            ],
          })}
        />,
      );
    });

    const renderedText = container.textContent ?? "";
    const summary = "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.";
    expect(renderedText.split(summary)).toHaveLength(2);
    expect(renderedText).not.toContain("controller credential fetch failed");
  });

  it("does not draw an empty compact rail for expanded terminal-only failures", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isThreadPreviewExpanded: true,
            finalSpineTone: "danger",
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex completed without returning a final assistant message after retry.",
            }),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-compact-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-thread-terminal-status"]')?.textContent).toBe(
      "Run failed",
    );
  });

  it("keeps attached completed lead summaries tight by hiding duplicate run chrome", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            hideThreadSpine: true,
            showHeaderAvatar: false,
            visibleCompactEvents: [{ id: "command", kind: "command", actorHandle: "@octo" }],
            latestCompactEventId: "command",
            overflowCompactCount: 2,
            finalSummaryMessage: createMessage({
              id: "lead-summary",
              content: "Severity-ranked findings. ".repeat(28),
            }),
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Severity-ranked findings.");
    expect(container.querySelector('[data-testid="agent-thread-owner-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-thread-compact-rail"]')).toBeNull();
  });

  it("keeps short completed replies close to the prompt by hiding duplicate run chrome", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            showHeaderAvatar: false,
            visibleCompactEvents: [{ id: "command", kind: "command", actorHandle: "@octo" }],
            latestCompactEventId: "command",
            finalSummaryMessage: createMessage({
              id: "short-summary",
              content: "The codec-audit lane found it.",
            }),
          })}
        />,
      );
    });

    expect(container.textContent).toContain("The codec-audit lane found it.");
    expect(container.querySelector('[data-testid="agent-thread-compact-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-spine"]')).toBeNull();
  });

  it("lets terminal failure status dominate collapsed progress notches", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSpineTone: "danger",
            visibleCompactEvents: [{ id: "thinking", kind: "thinking", actorHandle: "@octo" }],
            latestCompactEventId: "thinking",
            singleCompactEvent: { id: "thinking", kind: "thinking", actorHandle: "@octo" },
            singleCompactEventLabel: "Thinking",
            finalSummaryMessage: createMessage({
              id: "error-summary",
              content: "Codex completed without returning a final assistant message after retry.",
            }),
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-terminal-status"]')?.textContent).toBe(
      "Run failed",
    );
    expect(container.textContent).not.toContain("Thinking");
    expect(container.querySelector('button[aria-label="Expand run updates"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-thread-preview-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-spine"]')).toBeNull();
  });

  it("hides stale or completed reasoning-only run chrome with no useful summary", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSummaryMessage: null,
            hasPreview: true,
            previewText: "Reasoning",
            showSummaryBody: false,
            isCompleted: true,
            isRunning: false,
            isThreadUnresolved: false,
            latestFiles: [],
            visibleCompactEvents: [{ id: "thinking", kind: "thinking", actorHandle: "@octo" }],
            latestCompactEventId: "thinking",
            singleCompactEvent: { id: "thinking", kind: "thinking", actorHandle: "@octo" },
            singleCompactEventLabel: "Reasoning",
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-job-thread-preview"]')).toBeNull();
    expect(container.textContent).not.toContain("Reasoning");
    expect(container.textContent).not.toContain("Thinking");
  });

  it("hides completed run previews that would only render chrome actions", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            finalSummaryMessage: null,
            hasPreview: false,
            previewText: "",
            showSummaryBody: false,
            isCompleted: true,
            isRunning: false,
            isThreadUnresolved: false,
            isHybridCompactionActive: true,
            latestFiles: [],
            visibleCompactEvents: [],
            overflowCompactCount: 0,
            updatesForInlineRendering: [],
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-job-thread-preview"]')).toBeNull();
    expect(container.querySelector('[aria-label="Open run trace"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-thread-compact-rail"]')).toBeNull();
  });

  it("renders child thread branch rows only when run updates are expanded", async () => {
    const openBranchThread = vi.fn();
    const branchThreads = [
      {
        threadLocalId: "child-thread-local",
        title: "Preview cleanup smoke",
        hiddenActivityCount: 3,
        isRunning: true,
        participants: [
          { handle: "octo", avatarSeed: "octo" },
          { handle: "ben", avatarSeed: "ben" },
        ],
      },
    ];

    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            branchThreads,
            onOpenBranchThread: openBranchThread,
            isThreadPreviewExpanded: false,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-branch-row"]')).toBeNull();

    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            branchThreads,
            onOpenBranchThread: openBranchThread,
            isThreadPreviewExpanded: true,
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="agent-thread-branch-row"]')?.textContent).toContain(
      "Preview cleanup smoke",
    );
    expect(container.querySelector('[aria-label="Participants: @octo, @ben"]')).not.toBeNull();
    const hiddenActivityIndicator = container.querySelector(
      '[aria-label="3 child thread updates"]',
    ) as HTMLElement | null;
    expect(hiddenActivityIndicator?.dataset.count).toBe("3");
    expect(hiddenActivityIndicator?.textContent).toBe("");
    expect(container.querySelector('[aria-label="Child thread is running"]')).not.toBeNull();

    const openButton = container.querySelector(
      'button[aria-label="Open child thread: Preview cleanup smoke"]',
    ) as HTMLButtonElement | null;
    expect(openButton).not.toBeNull();
    await act(async () => {
      openButton?.click();
    });
    expect(openBranchThread).toHaveBeenCalledWith("child-thread-local");
  });

  it("renders generic multi-agent plan metadata as team progress", async () => {
    await act(async () => {
      root.render(
        <AgentJobThreadPreviewLayout
          {...createProps({
            isThreadPreviewExpanded: true,
            updatesForInlineRendering: [
              createMessage({
                id: "team-plan",
                messageType: "multi_agent_plan",
                content: "I'm splitting this into workstreams.",
                metadata: {
                  messageType: "multi_agent_plan",
                  details: {
                    mode: "read_only",
                    thresholdReason: "Broad cross-domain audit benefits from split investigation.",
                    agents: [
                      {
                        handle: "front",
                        label: "Frontend",
                        scopeSummary: "Auth/session UI and client state.",
                        writeScope: { mode: "read_only" },
                      },
                      {
                        handle: "api",
                        label: "API",
                        scopeSummary: "Authorization and controller routes.",
                        writeScope: { mode: "read_only" },
                      },
                    ],
                    lead: {
                      leadHandle: "octo",
                      continuationPrompt: "Review sibling outputs and choose the next coordination step.",
                      expectedReportFormat: "Severity-ranked findings with evidence.",
                    },
                  },
                },
              }),
            ],
          })}
        />,
      );
    });

    expect(container.querySelector('[data-testid="multi-agent-inline-status"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-plan-card"]')).toBeNull();
    expect(container.textContent).toContain("I'm splitting this into workstreams.");
    expect(container.textContent).toContain("@front");
    expect(container.textContent).toContain("@octo");
    expect(container.textContent).not.toContain("Auth/session UI and client state.");
    expect(container.textContent).not.toContain("Lead: @octo");
    expect(container.textContent).not.toContain("Severity-ranked findings with evidence.");
  });
});
