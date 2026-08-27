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
      { handle: "octo", displayName: "Octo", avatarSeed: "octo" },
      { handle: "pixel", displayName: "Pixel", avatarSeed: "pixel" },
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
    window.localStorage.clear();
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(forceRail = false) {
    await act(async () => {
      root.render(<ParticipantsDrawer forceRail={forceRail} />);
    });
  }

  it("renders nothing without a published snapshot", async () => {
    await render();
    expect(container.querySelector("aside")).toBeNull();
  });

  it("shows people, agents, conversation summary, and the credit pool", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();

    const drawer = container.querySelector('[data-testid="participants-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain("Taylor");
    expect(drawer?.textContent).toContain("Kim Larsen");
    expect(drawer?.textContent).toContain("@octo");
    expect(drawer?.textContent).toContain("Running");
    expect(
      container.querySelector('[data-testid="participants-drawer-summary"]')?.textContent,
    ).toBe("1 running · 2 messages queued");
    const credits = container.querySelector('[data-testid="participants-drawer-credits"]');
    expect(credits?.textContent).toContain("162 / 200");
    expect(credits?.querySelector('[role="meter"]')).not.toBeNull();
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

  it("collapses to the avatar rail and remembers the choice", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render();

    const collapse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse participants"]',
    );
    expect(collapse).not.toBeNull();
    await act(async () => {
      collapse?.click();
    });
    expect(container.querySelector('[data-testid="participants-drawer-rail"]')).not.toBeNull();
    expect(window.localStorage.getItem("instafy.participantsDrawer.collapsed.v1")).toBe("1");
  });

  it("forceRail yields the rail without an expand control", async () => {
    await act(async () => {
      publishChatParticipants(snapshot());
    });
    await render(true);
    expect(container.querySelector('[data-testid="participants-drawer-rail"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Expand participants"]'),
    ).toBeNull();
  });
});
