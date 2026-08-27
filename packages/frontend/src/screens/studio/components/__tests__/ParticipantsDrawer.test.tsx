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
        credentialLabel: "My ChatGPT",
        credentialState: "default",
      },
      {
        handle: "pixel",
        displayName: "Pixel",
        avatarSeed: "pixel",
        model: "gpt-5.5",
        providerLabel: "OpenAI",
        credentialLabel: null,
        credentialState: "revoked",
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
    expect(drawer?.textContent).toContain("Marcus");
    expect(drawer?.textContent).toContain("@octo");
    expect(drawer?.textContent).toContain("gpt-5.5 · OpenAI");
    expect(drawer?.textContent).toContain("Using default · My ChatGPT");
    expect(drawer?.textContent).toContain("Pinned credential was revoked");
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
});
