// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTypingRows } from "../ChatTypingRows";

describe("ChatTypingRows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not duplicate assistant status text with activity dots", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    const indicator = container.querySelector('[data-testid="assistant-typing-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.querySelector("[data-sweep-text]")?.textContent).toBe("Thinking…");
    expect(indicator?.querySelectorAll(".animate-pulse")).toHaveLength(0);
    const speakerMarker = container.querySelector('[data-testid="chat-speaker-marker"]');
    expect(speakerMarker?.getAttribute("data-chat-speaker-kind")).toBe("assistant");
    expect(speakerMarker?.getAttribute("data-agent-handle")).toBe("octo");
    expect(
      container
        .querySelector('[data-testid="assistant-thinking-octo-compact"] .octo-mark')
        ?.getAttribute("data-octo-motion"),
    ).toBe("thinking");
  });

  it("passes motion only for live thinking and returns Octo to rest while waiting", async () => {
    const renderAssistantAvatar = vi.fn(
      (
        _metadata?: Record<string, unknown> | null,
        _identity?: { handle: string; avatarSeed: string } | null,
        options?: { motion?: "idle" | "thinking"; scrollReactive?: boolean },
      ) => (
        <span
          data-testid="assistant-avatar"
          data-motion={options?.motion}
          data-scroll-reactive={String(options?.scrollReactive ?? false)}
        />
      ),
    );

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Octo is thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={renderAssistantAvatar}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-avatar"]')?.getAttribute("data-motion"))
      .toBe("thinking");
    expect(
      container
        .querySelector('[data-testid="assistant-avatar"]')
        ?.getAttribute("data-scroll-reactive"),
    ).toBe("true");

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "waiting", label: null }}
          typingStatusLabel="Octo is starting its workspace…"
          typingStatusAriaLabel="Octo is starting its workspace"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={renderAssistantAvatar}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-avatar"]')?.getAttribute("data-motion"))
      .toBe("idle");
    expect(
      container
        .querySelector('[data-testid="assistant-avatar"]')
        ?.getAttribute("data-scroll-reactive"),
    ).toBe("true");
    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();
  });

  it("marks peer-human typing as a sticky assistant boundary", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel="Alice is typing"
          isAssistantTyping={false}
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={null}
          typingStatusLabel="Typing…"
          typingStatusAriaLabel="Typing"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="human-typing-indicator"]')).not.toBeNull();
    const boundary = container.querySelector('[data-testid="chat-speaker-boundary"]');
    expect(boundary?.getAttribute("data-chat-speaker-kind")).toBe("boundary");
    expect(container.querySelector('[data-testid="chat-speaker-marker"]')).toBeNull();
  });

  it("marks aggregate multi-agent typing as a neutral speaker boundary", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[
            { handle: "octo", avatarSeed: "octo", displayName: "Octo", isThinking: true },
            {
              handle: "reviewer",
              avatarSeed: "reviewer",
              displayName: "Reviewer",
              isThinking: true,
            },
          ]}
          hasMultipleTypingAgents
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: null }}
          typingStatusLabel="2 agents are working…"
          typingStatusAriaLabel="2 agents are working"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).not.toBeNull();
    const boundary = container.querySelector('[data-testid="chat-speaker-boundary"]');
    expect(boundary?.getAttribute("data-chat-speaker-kind")).toBe("boundary");
    expect(container.querySelector('[data-testid="chat-speaker-marker"]')).toBeNull();
  });

  it("animates only the Octo run that is actually in progress in a multi-agent row", async () => {
    const render = async (octoIsThinking: boolean) => {
      await act(async () => {
        root.render(
          <ChatTypingRows
            peerTypingLabel={null}
            isAssistantTyping
            isAssistantTypingCoveredByJobThreadPreview={false}
            typingAgents={[
              {
                handle: "octo",
                avatarSeed: "octo",
                displayName: "Octo",
                isThinking: octoIsThinking,
              },
              {
                handle: "reviewer",
                avatarSeed: "reviewer",
                displayName: "Reviewer",
                isThinking: !octoIsThinking,
              },
            ]}
            hasMultipleTypingAgents
            typingAgentHandle="octo"
            typingAgentAvatarSeed="octo"
            typingIndicatorState={{ phase: "thinking", label: null }}
            typingStatusLabel="Thinking…"
            typingStatusAriaLabel="Octo and Reviewer are thinking"
            isThinkingLabelExpanded={false}
            onToggleThinkingLabel={() => undefined}
            latestDisplayedMessageId="message-1"
            renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
          />,
        );
      });
    };

    await render(false);
    expect(container.querySelector(".octo-mark")?.getAttribute("data-octo-motion")).toBe("idle");
    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();

    await render(true);
    expect(container.querySelector(".octo-mark")?.getAttribute("data-octo-motion")).toBe(
      "thinking",
    );
    expect(
      container
        .querySelector('[data-testid="assistant-thinking-octo-compact"] .octo-mark')
        ?.getAttribute("data-octo-motion"),
    ).toBe("thinking");
  });

  it("does not replace a customized Octo avatar with the canonical compact mark", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Octo is thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();
  });

  it("keeps workspace startup visibly owned by the assistant avatar", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "waiting", label: null }}
          typingStatusLabel="Octo is starting its workspace…"
          typingStatusAriaLabel="Octo is starting its workspace"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-testid="assistant-typing-indicator"] [data-sweep-text]')
        ?.textContent,
    ).toBe("Octo is starting its workspace…");
    expect(container.textContent).not.toContain("Starting…");
  });

  it("keeps a hidden assistant status spacer until the next message lands", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping={false}
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={null}
          typingStatusLabel="Typing…"
          typingStatusAriaLabel="Typing"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    const lingeringIndicator = container.querySelector('[data-testid="assistant-typing-indicator"]');
    expect(lingeringIndicator).toBeInstanceOf(HTMLElement);
    expect(lingeringIndicator?.className).toContain("invisible");
    expect(lingeringIndicator?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeInstanceOf(HTMLElement);

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping={false}
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={null}
          typingStatusLabel="Typing…"
          typingStatusAriaLabel="Typing"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-2"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeNull();
  });

  it("clears the assistant status immediately when suppressed", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeInstanceOf(HTMLElement);

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          suppressAssistantStatus
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeNull();
  });
});
