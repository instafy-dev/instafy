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

function snapshot(overrides: Partial<ChatParticipantsSnapshot> = {}): ChatParticipantsSnapshot {
  return {
    conversationId: "conv-1",
    humans: [
      { userId: "u1", label: "Marcus", isSelf: true },
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
        credentialKind: "codex_auth_json",
        credentialState: "default",
        subscriptionUsage: {
          windows: [
            {
              kind: "primary",
              usedPercent: 12, // 88% left — plentiful, so the roster stays silent
              windowMinutes: 300,
              resetAt: Math.floor(Date.parse("2026-08-28T12:10:00Z") / 1000),
            },
            {
              kind: "secondary",
              usedPercent: 40, // 60% left — also not news
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

  it("shows people and agents, staying silent about healthy defaults", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();

    const drawer = container.querySelector('[data-testid="participants-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain("Marcus");
    expect(drawer?.textContent).toContain("@octo");
    expect(drawer?.textContent).toContain("gpt-5.5");
    // Silence rules: the healthy default credential says nothing, the reset
    // detail stays hidden while headroom is plentiful, and team credits are
    // not this panel's business.
    expect(drawer?.textContent).not.toContain("ChatGPT subscription");
    expect(drawer?.textContent).not.toContain("My ChatGPT");
    expect(container.querySelector('[data-testid="participants-usage"]')).toBeNull();
    // ...but the headline headroom (tightest window) rides the row for
    // at-a-glance comparison: min(88, 60) = 60.
    expect(
      container.querySelector('[data-testid="participants-agent-headroom"]')?.textContent,
    ).toContain("60% left");
    expect(container.querySelector('[data-testid="participants-drawer-credits"]')).toBeNull();
    // Problems still speak: pixel's revoked credential.
    expect(drawer?.textContent).toContain("Its credential was revoked");
    expect(drawer?.textContent).toContain("Running");
    expect(
      container.querySelector('[data-testid="participants-drawer-summary"]')?.textContent,
    ).toBe("1 running · 2 messages queued");
  });

  it("surfaces only the windows that are running low, with reset times", async () => {
    const agents = snapshot().agents.map((agent) =>
      agent.handle === "octo"
        ? {
            ...agent,
            subscriptionUsage: {
              windows: [
                {
                  kind: "primary" as const,
                  usedPercent: 91, // 9% left → red, shown
                  windowMinutes: 300,
                  resetAt: Math.floor(Date.parse("2026-08-28T12:10:00Z") / 1000),
                },
                {
                  kind: "secondary" as const,
                  usedPercent: 40, // 60% left → silent
                  windowMinutes: 10080,
                  resetAt: Math.floor(Date.parse("2026-09-02T09:00:00Z") / 1000),
                },
              ],
              planName: null,
              capturedAt: Math.floor(Date.parse("2026-08-28T09:55:00Z") / 1000),
            },
          }
        : agent,
    );
    await act(async () => {
      publishChatParticipants(snapshot({ agents }));
    });
    await render();

    const usage = container.querySelector('[data-testid="participants-usage"]');
    expect(usage).not.toBeNull();
    const windows = container.querySelectorAll('[data-testid="participants-usage-window"]');
    expect(windows.length).toBe(1); // only the low 5h window, not the healthy weekly
    const text = usage?.textContent ?? "";
    expect(text).toContain("5h");
    expect(text).toContain("9% left");
    expect(text).toContain("resets in 2h 10m");
    expect(text).not.toContain("60% left");
  });

  it("treats a lapsed window as rolled over — nothing to warn about", async () => {
    const agents = [
      {
        ...snapshot().agents[0],
        subscriptionUsage: {
          windows: [
            {
              kind: "primary" as const,
              usedPercent: 90, // was nearly exhausted...
              windowMinutes: 300,
              // ...but the reset time passed an hour ago (pinned clock 10:00Z).
              resetAt: Math.floor(Date.parse("2026-08-28T09:00:00Z") / 1000),
            },
          ],
          planName: null,
          capturedAt: Math.floor(Date.parse("2026-08-28T03:00:00Z") / 1000),
        },
      },
    ];
    await act(async () => {
      publishChatParticipants(snapshot({ agents, runningAgentHandles: [], totalQueuedCount: 0 }));
    });
    await render();
    // Rolled over → full allowance again → silent, not "10% left".
    expect(container.querySelector('[data-testid="participants-usage"]')).toBeNull();
  });

  it("warns once when agents share a low credential", async () => {
    const lowUsage = {
      windows: [
        {
          kind: "primary" as const,
          usedPercent: 90,
          windowMinutes: 300,
          resetAt: Math.floor(Date.parse("2026-08-28T12:00:00Z") / 1000),
        },
      ],
      planName: null,
      capturedAt: Math.floor(Date.parse("2026-08-28T09:55:00Z") / 1000),
    };
    const shared = (handle: string, avatarSeed: string) => ({
      handle,
      displayName: handle,
      avatarSeed,
      model: "gpt-5.5",
      providerLabel: "OpenAI",
      credentialId: "cred-shared",
      credentialLabel: "My ChatGPT",
      credentialState: "default" as const,
      subscriptionUsage: lowUsage,
    });
    await act(async () => {
      publishChatParticipants(
        snapshot({
          agents: [shared("octo", "octo"), shared("pixel", "pixel")],
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();
    // Both agents draw on "cred-shared" → the reset-detail renders once, not
    // twice — but the headline % rides BOTH rows, so neither sibling looks
    // deceptively fine on a drained shared account.
    expect(container.querySelectorAll('[data-testid="participants-usage"]').length).toBe(1);
    const headrooms = container.querySelectorAll(
      '[data-testid="participants-agent-headroom"]',
    );
    expect(headrooms.length).toBe(2);
    expect(headrooms[0]?.textContent).toContain("10% left");
    expect(headrooms[1]?.textContent).toContain("10% left");
  });

  it("statuses stay conversation-scoped: idle agents show no marker", async () => {
    await act(async () => {
      publishChatParticipants(snapshot({ runningAgentHandles: [], totalQueuedCount: 0 }));
    });
    await render();
    const drawer = container.querySelector('[data-testid="participants-drawer"]');
    expect(drawer?.textContent).not.toContain("Running");
    expect(container.querySelector('[data-testid="participants-drawer-summary"]')).toBeNull();
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
    await act(async () => {
      drawer?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays read-only (no inline controls) without an editing context", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();
    expect(container.querySelector('[data-testid="participants-agent-controls"]')).toBeNull();
    expect(container.querySelector('[data-testid="drawer-agent-model-select-octo"]')).toBeNull();
  });

  it("renders model + reasoning as inline editable tokens with an editing context", async () => {
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
              reasoningEffort: "high",
              providerLabel: "OpenAI",
              credentialId: "cred-1",
              credentialLabel: "My ChatGPT",
              credentialKind: "codex_auth_json",
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

    // No expand affordance — the tokens are present immediately.
    expect(container.querySelector('[data-testid="participants-agent-expand-octo"]')).toBeNull();
    const controls = container.querySelector('[data-testid="participants-agent-controls"]');
    expect(controls).not.toBeNull();
    const model = container.querySelector('[data-testid="drawer-agent-model-select-octo"]');
    const reasoning = container.querySelector(
      '[data-testid="drawer-agent-reasoning-select-octo"]',
    );
    expect(model?.textContent).toContain("gpt-5.5");
    expect(reasoning?.textContent).toContain("High");
  });

  it("pinned credentials speak; default ones stay silent", async () => {
    const base = snapshot().agents[0];
    await act(async () => {
      publishChatParticipants(
        snapshot({
          agents: [
            { ...base, subscriptionUsage: null },
            {
              ...base,
              handle: "scout",
              avatarSeed: "scout",
              credentialState: "pinned",
              subscriptionUsage: null,
            },
          ],
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();
    const text =
      container.querySelector('[data-testid="participants-drawer"]')?.textContent ?? "";
    expect(text).toContain("ChatGPT subscription · pinned"); // scout, non-default
    expect(text).not.toMatch(/ChatGPT subscription(?! · pinned)/); // octo's default is silent
  });

  it("shows one quiet footer when every agent shares one machine", async () => {
    const cloudRuntime = {
      id: "rt-cloud",
      label: "Instafy Cloud",
      kind: "shared" as const,
      status: "online",
      resourcesSummary: "2 vCPU · 4 GB",
    };
    const agents = snapshot().agents.map((agent) => ({
      ...agent,
      credentialState: "default" as const,
      credentialId: "cred-1",
      subscriptionUsage: null,
      runtime: cloudRuntime,
    }));
    await act(async () => {
      publishChatParticipants(snapshot({ agents, runningAgentHandles: [], totalQueuedCount: 0 }));
    });
    await render();

    // No per-machine headers, no indent rail — just the footer.
    expect(container.querySelectorAll('[data-testid="participants-runtime-group"]').length).toBe(
      0,
    );
    const footer = container.querySelector('[data-testid="participants-machine-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain("All on Instafy Cloud · shared");
    // Healthy machine → no status word.
    expect(footer?.textContent).not.toContain("online");
    const section = container.querySelector('section[aria-label="Agents"]');
    expect(section?.textContent).toContain("Agents");
    expect(section?.textContent).not.toContain("Runtimes & agents");
  });

  it("hosts the conversation's assistant switch and the manage-agents door", async () => {
    const onToggle = vi.fn();
    const onManageAgents = vi.fn();
    await act(async () => {
      publishChatParticipants(
        snapshot({
          assistant: { enabled: true, hint: null, onToggle },
          editing: { credentials: [], saveAgent: vi.fn(), onManageAgents },
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();

    const toggle = container.querySelector('[data-testid="participants-assistant-toggle"]');
    expect(toggle).not.toBeNull();
    const manage = container.querySelector<HTMLButtonElement>(
      '[data-testid="participants-manage-agents"]',
    );
    expect(manage).not.toBeNull();
    await act(async () => {
      manage?.click();
    });
    expect(onManageAgents).toHaveBeenCalledTimes(1);
  });

  it("shows no assistant footer without the control", async () => {
    await act(async () => {
      publishChatParticipants(snapshot({ runningAgentHandles: [], totalQueuedCount: 0 }));
    });
    await render();
    expect(
      container.querySelector('[data-testid="participants-assistant-toggle"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="participants-manage-agents"]')).toBeNull();
  });

  it("machine rows deep-link to the Machines page when a handler is provided", async () => {
    const cloudRuntime = {
      id: "rt-cloud",
      label: "Instafy Cloud",
      kind: "shared" as const,
      status: "online",
      resourcesSummary: null,
    };
    const agents = snapshot().agents.map((agent) => ({
      ...agent,
      credentialState: "default" as const,
      credentialId: "cred-1",
      subscriptionUsage: null,
      runtime: cloudRuntime,
    }));
    await act(async () => {
      publishChatParticipants(snapshot({ agents, runningAgentHandles: [], totalQueuedCount: 0 }));
    });
    const onOpenMachine = vi.fn();
    await act(async () => {
      root.render(<ParticipantsDrawer onClose={vi.fn()} onOpenMachine={onOpenMachine} />);
    });

    const footer = container.querySelector<HTMLButtonElement>(
      '[data-testid="participants-machine-footer"]',
    );
    expect(footer?.tagName).toBe("BUTTON");
    await act(async () => {
      footer?.click();
    });
    expect(onOpenMachine).toHaveBeenCalledWith("rt-cloud");
  });

  it("groups agents under machine headers only when machines differ", async () => {
    const cloudRuntime = {
      id: "rt-cloud",
      label: "Instafy Cloud",
      kind: "shared" as const,
      status: "ready",
      resourcesSummary: "2 vCPU · 4 GB",
    };
    const baseAgent = {
      displayName: "",
      providerLabel: "OpenAI",
      credentialState: "default" as const,
      subscriptionUsage: null,
    };
    await act(async () => {
      publishChatParticipants(
        snapshot({
          agents: [
            {
              ...baseAgent,
              handle: "octo",
              avatarSeed: "octo",
              model: "gpt-5.5",
              credentialId: "c1",
              credentialLabel: "My ChatGPT",
              runtime: cloudRuntime,
            },
            {
              ...baseAgent,
              handle: "scout",
              avatarSeed: "scout",
              model: "o4-mini",
              credentialId: "c1",
              credentialLabel: "My ChatGPT",
              runtime: cloudRuntime,
            },
            {
              ...baseAgent,
              handle: "pixel",
              avatarSeed: "pixel",
              model: "gpt-5.5",
              credentialId: "c2",
              credentialLabel: "Local",
              runtime: {
                id: "rt-mac",
                label: "Your Mac",
                kind: "native" as const,
                status: "booting",
                resourcesSummary: null,
              },
            },
          ],
          runningAgentHandles: [],
          totalQueuedCount: 0,
        }),
      );
    });
    await render();

    const groups = container.querySelectorAll('[data-testid="participants-runtime-group"]');
    expect(groups.length).toBe(2);
    expect(container.querySelector('[data-testid="participants-machine-footer"]')).toBeNull();
    const text = container.querySelector('section[aria-label="Agents"]')?.textContent ?? "";
    expect(text).toContain("Runtimes & agents");
    expect(text).toContain("Instafy Cloud");
    expect(text).toContain("Shared · 2");
    expect(text).toContain("Your Mac");
    expect(text).toContain("Native");
    expect(text).toContain("this machine");
    expect(text).toContain("booting"); // unhealthy status is spelled out
    expect(text).toContain("@octo");
    expect(text).toContain("@scout");
    expect(text).toContain("@pixel");
  });
});
