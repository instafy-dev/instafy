// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationRoster } from "../ConversationRoster";
import { setParticipantsDrawerOpen } from "../chatParticipantsStore";
import type {
  ConversationRosterAgent,
  ConversationRosterHuman,
} from "../conversationRosterMembers";

function human(userId: string, label: string, isSelf = false): ConversationRosterHuman {
  return { userId, label, isSelf };
}

function agent(handle: string, displayName: string, avatarSeed: string): ConversationRosterAgent {
  return { handle, displayName, avatarSeed };
}

describe("ConversationRoster", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setParticipantsDrawerOpen(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    setParticipantsDrawerOpen(false);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderRoster(
    humans: ConversationRosterHuman[],
    agents: ConversationRosterAgent[],
    hasCredentialWarning = false,
  ) {
    await act(async () => {
      root.render(
        <ConversationRoster
          humans={humans}
          agents={agents}
          hasCredentialWarning={hasCredentialWarning}
        />,
      );
    });
  }

  it("stacks humans before agents and reports the member count", async () => {
    await renderRoster(
      [human("user-self", "Taylor", true), human("user-peer", "Ada")],
      [agent("octo", "Octo", "octo")],
    );

    const trigger = container.querySelector('[data-testid="conversation-roster"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Conversation members (3)");

    const stackedAvatars = trigger?.querySelectorAll(
      '[data-testid="chat-avatar-human"], [data-testid="chat-avatar-assistant"]',
    );
    expect(stackedAvatars?.length).toBe(3);
    expect(stackedAvatars?.[0]?.getAttribute("data-testid")).toBe("chat-avatar-human");
    expect(stackedAvatars?.[2]?.getAttribute("data-testid")).toBe("chat-avatar-assistant");
    expect(container.querySelector('[data-testid="conversation-roster-overflow"]')).toBeNull();
  });

  it("collapses members past five into a +N overflow", async () => {
    await renderRoster(
      [
        human("user-self", "Taylor", true),
        human("user-a", "Ada"),
        human("user-b", "Grace"),
        human("user-c", "Alan"),
      ],
      [
        agent("octo", "Octo", "octo"),
        agent("scout", "Scout", "seed-scout"),
        agent("medic", "Medic", "seed-medic"),
      ],
    );

    const trigger = container.querySelector('[data-testid="conversation-roster"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Conversation members (7)");
    expect(
      container.querySelector('[data-testid="conversation-roster-overflow"]')?.textContent,
    ).toBe("+2");
  });

  it("toggles the participants drawer when pressed", async () => {
    await renderRoster([human("user-self", "Taylor", true)], [agent("octo", "Octo", "octo")]);
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-roster"]',
    );
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      trigger?.click();
    });
    expect(
      container
        .querySelector('[data-testid="conversation-roster"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="conversation-roster"]')?.click();
    });
    expect(
      container
        .querySelector('[data-testid="conversation-roster"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("shows an ambient warning dot when a credential needs attention", async () => {
    await renderRoster([], [agent("octo", "Octo", "octo")], true);
    expect(
      container.querySelector('[data-testid="conversation-roster-warning"]'),
    ).not.toBeNull();

    await renderRoster([], [agent("octo", "Octo", "octo")], false);
    expect(container.querySelector('[data-testid="conversation-roster-warning"]')).toBeNull();
  });

  it("renders each agent with its own avatar seed", async () => {
    await renderRoster(
      [human("user-self", "Taylor", true)],
      [
        agent("octo", "Octo", "octo"),
        agent("scout", "Scout", "seed-scout"),
        agent("medic", "Medic", "seed-medic"),
      ],
    );

    const trigger = container.querySelector('[data-testid="conversation-roster"]');
    const agentAvatars = Array.from(
      trigger?.querySelectorAll('[data-testid="chat-avatar-assistant"]') ?? [],
    );
    expect(agentAvatars.length).toBe(3);
    const scoutStyle = agentAvatars[1]?.getAttribute("style") ?? "";
    const medicStyle = agentAvatars[2]?.getAttribute("style") ?? "";
    expect(scoutStyle).toContain("linear-gradient");
    expect(scoutStyle).not.toBe(medicStyle);
  });

  it("renders nothing when there are no members", async () => {
    await renderRoster([], []);
    expect(container.querySelector('[data-testid="conversation-roster"]')).toBeNull();
  });

  it("keeps the trigger ambient: no panel background, border, shadow or blur", async () => {
    await renderRoster([human("user-self", "Taylor", true)], [agent("octo", "Octo", "octo")]);
    const triggerClass =
      container.querySelector('[data-testid="conversation-roster"]')?.getAttribute("class") ?? "";
    expect(triggerClass).toContain("bg-transparent");
    expect(triggerClass).toContain("border-0");
    expect(triggerClass).toContain("shadow-none");
    expect(triggerClass).not.toContain("backdrop-blur");
  });
});
