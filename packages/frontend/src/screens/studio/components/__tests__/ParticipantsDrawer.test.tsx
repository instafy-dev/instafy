// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParticipantsDrawer } from "../ParticipantsDrawer";
import {
  clearChatParticipants,
  publishChatParticipants,
  type ChatParticipantsSnapshot,
} from "../chatParticipantsStore";

const creditsMock = {
  billing: { creditBalance: 162, creditLimit: 200 },
  hasLoaded: true,
  controllerEnabled: true,
};
vi.mock("../../../../credits/useCredits", () => ({
  useCredits: () => creditsMock,
}));

function snapshot(overrides: Partial<ChatParticipantsSnapshot> = {}): ChatParticipantsSnapshot {
  return {
    conversationId: "conv-1",
    humans: [
      { userId: "u1", label: "Taylor", isSelf: true },
      { userId: "u2", label: "Kim Larsen", isSelf: false },
    ],
    agents: [
      {
        handle: "octo",
        displayName: "Octo",
        avatarSeed: "octo",
        model: "gpt-5.5",
        providerLabel: "OpenAI",
        credentialId: "cred-1",
        credentialLabel: "My ChatGPT",
        credentialState: "default",
        subscriptionUsage: {
          windows: [
            {
              kind: "primary",
              usedPercent: 12,
              windowMinutes: 300,
              resetAt: Math.floor(Date.parse("2026-08-28T12:10:00Z") / 1000),
            },
            {
              kind: "secondary",
              usedPercent: 40,
              windowMinutes: 10080,
              resetAt: Math.floor(Date.parse("2026-09-02T09:00:00Z") / 1000),
            },
          ],
          planName: "GPT-5.5-Codex",
          capturedAt: Math.floor(Date.parse("2026-08-28T09:55:00Z") / 1000),
        },
      },
      {
        handle: "pixel",
        displayName: "Pixel",
        avatarSeed: "pixel",
        model: "gpt-5.5",
        providerLabel: "OpenAI",
        credentialId: null,
        credentialLabel: null,
        credentialState: "revoked",
        subscriptionUsage: null,
      },
    ],
    runningAgentHandles: ["octo"],
    totalQueuedCount: 2,
    ...overrides,
  };
}

describe("ParticipantsDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Pin the clock so relative reset times ("resets in 2h 10m") are deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearChatParticipants("conv-1");
    clearChatParticipants(null);
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(onClose = vi.fn()) {
    await act(async () => {
      root.render(<ParticipantsDrawer onClose={onClose} />);
    });
    return onClose;
  }

  it("shows people, agents with model/provider/credential, summary, and credit pool", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();

    const drawer = container.querySelector('[data-testid="participants-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain("Taylor");
    expect(drawer?.textContent).toContain("@octo");
    expect(drawer?.textContent).toContain("gpt-5.5 · OpenAI");
    // Default credential leads with just the account name (no "Using default").
    expect(drawer?.textContent).toContain("My ChatGPT");
    expect(drawer?.textContent).not.toContain("Using default");
    expect(drawer?.textContent).toContain("Its credential was revoked");
    expect(drawer?.textContent).toContain("Running");
    expect(
      container.querySelector('[data-testid="participants-drawer-summary"]')?.textContent,
    ).toBe("1 running · 2 messages queued");
    const credits = container.querySelector('[data-testid="participants-drawer-credits"]');
    expect(credits?.textContent).toContain("162 / 200");
    expect(credits?.querySelector('[role="meter"]')).not.toBeNull();
  });

  it("renders subscription usage meters: 5h + weekly, remaining %, relative reset when close", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();

    const usage = container.querySelector('[data-testid="participants-usage"]');
    expect(usage).not.toBeNull();
    const windows = container.querySelectorAll('[data-testid="participants-usage-window"]');
    expect(windows.length).toBe(2);
    const text = usage?.textContent ?? "";
    // 5h window first (sorted by length), used 12% → 88% left, reset ~2h out → relative.
    expect(text).toContain("5h");
    expect(text).toContain("88% left");
    expect(text).toContain("resets in 2h 10m");
    // Weekly window, used 40% → 60% left; reset is days out so it isn't relative.
    expect(text).toContain("Weekly");
    expect(text).toContain("60% left");
    expect(text).not.toContain("Weekly · resets in");
    // Usage rows are text-only now; the only meter left is the team-credits bar.
    expect(container.querySelectorAll('[role="meter"]').length).toBe(1);
  });

  it("presents a lapsed window as refreshed, not drained", async () => {
    await act(async () => {
      publishChatParticipants(
        snapshot({
          agents: [
            {
              handle: "octo",
              displayName: "Octo",
              avatarSeed: "octo",
              model: "gpt-5.5",
              providerLabel: "OpenAI",
              credentialId: "cred-1",
              credentialLabel: "My ChatGPT",
              credentialState: "default",
              subscriptionUsage: {
                windows: [
                  {
                    kind: "primary",
                    usedPercent: 90, // was nearly exhausted...
                    windowMinutes: 300,
                    // ...but the reset time is an hour in the PAST relative to
                    // the pinned clock (10:00Z), with no newer snapshot.
                    resetAt: Math.floor(Date.parse("2026-08-28T09:00:00Z") / 1000),
                  },
                ],
                planName: null,
                capturedAt: Math.floor(Date.parse("2026-08-28T03:00:00Z") / 1000),
              },
            },
          ],
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();
    const usage = container.querySelector('[data-testid="participants-usage"]');
    const text = usage?.textContent ?? "";
    expect(text).toContain("just reset");
    expect(text).toContain("100% left"); // rolled over → full, not "10% left"
    expect(text).not.toContain("10% left");
  });

  it("shows one set of meters when agents share a credential", async () => {
    await act(async () => {
      publishChatParticipants(
        snapshot({
          agents: [
            {
              handle: "octo",
              displayName: "Octo",
              avatarSeed: "octo",
              model: "gpt-5.5",
              providerLabel: "OpenAI",
              credentialId: "cred-shared",
              credentialLabel: "My ChatGPT",
              credentialState: "default",
              subscriptionUsage: {
                windows: [
                  {
                    kind: "primary",
                    usedPercent: 20,
                    windowMinutes: 300,
                    resetAt: Math.floor(Date.parse("2026-08-28T12:00:00Z") / 1000),
                  },
                ],
                planName: null,
                capturedAt: Math.floor(Date.parse("2026-08-28T09:55:00Z") / 1000),
              },
            },
            {
              handle: "pixel",
              displayName: "Pixel",
              avatarSeed: "pixel",
              model: "gpt-5.5",
              providerLabel: "OpenAI",
              credentialId: "cred-shared",
              credentialLabel: "My ChatGPT",
              credentialState: "default",
              subscriptionUsage: {
                windows: [
                  {
                    kind: "primary",
                    usedPercent: 20,
                    windowMinutes: 300,
                    resetAt: Math.floor(Date.parse("2026-08-28T12:00:00Z") / 1000),
                  },
                ],
                planName: null,
                capturedAt: Math.floor(Date.parse("2026-08-28T09:55:00Z") / 1000),
              },
            },
          ],
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();
    // Both agents draw on "cred-shared" → meters render once, not twice.
    expect(container.querySelectorAll('[data-testid="participants-usage"]').length).toBe(1);
  });

  it("statuses stay conversation-scoped: idle agents show no marker", async () => {
    await act(async () => {
      publishChatParticipants(snapshot({ runningAgentHandles: [], totalQueuedCount: 0 }));
    });
    await render();
    const drawer = container.querySelector('[data-testid="participants-drawer"]');
    expect(drawer?.textContent).not.toContain("Running");
    expect(
      container.querySelector('[data-testid="participants-drawer-summary"]'),
    ).toBeNull();
  });

  it("closes via the header button and Escape", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    const onClose = await render();

    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close participants"]',
    );
    expect(close).not.toBeNull();
    await act(async () => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes when clicking outside, but not inside the drawer", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    const onClose = await render();

    const drawer = container.querySelector('[data-testid="participants-drawer"]');
    // A click inside the drawer must not close it.
    await act(async () => {
      drawer?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    // A click anywhere outside closes it.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays read-only (no edit affordance) without an editing context", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();
    expect(
      container.querySelector('[data-testid="participants-agent-expand-octo"]'),
    ).toBeNull();
  });

  it("reveals inline model + reasoning controls when an editing context is present", async () => {
    const saveAgent = vi.fn().mockResolvedValue(true);
    await act(async () => {
      publishChatParticipants(
        snapshot({
          editing: { credentials: [], saveAgent },
          agents: [
            {
              handle: "octo",
              displayName: "Octo",
              avatarSeed: "octo",
              agentId: "agent-1",
              providerId: "openai",
              model: "gpt-5.5",
              reasoningEffort: null,
              providerLabel: "OpenAI",
              credentialId: "cred-1",
              credentialLabel: "My ChatGPT",
              credentialState: "default",
              subscriptionUsage: null,
            },
          ],
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();

    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="participants-agent-expand-octo"]',
    );
    expect(expand).not.toBeNull();
    // Collapsed by default — no controls yet.
    expect(container.querySelector('[data-testid="participants-agent-edit"]')).toBeNull();

    await act(async () => {
      expand?.click();
    });
    // Expanded: the model + reasoning pickers appear.
    expect(container.querySelector('[data-testid="participants-agent-edit"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drawer-agent-model-select-octo"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drawer-agent-reasoning-select-octo"]'),
    ).not.toBeNull();
  });
});
