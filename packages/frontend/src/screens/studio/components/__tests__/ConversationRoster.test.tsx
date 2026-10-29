// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationRoster } from "../ConversationRoster";
import {
  classTokens,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectPersonCircle,
} from "../../../../components/__tests__/octoCoinExpectations";
import { AI_TILE_SHAPE_CLASS } from "../../../../components/OctoCoin";
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

  it("separates overlapping faces with a ring on each face, above its coin shadow", async () => {
    await renderRoster([human("user-peer", "Ada")], [agent("octo", "Octo", "octo"), agent("reviewer", "Reviewer", "reviewer")]);
    const slots = Array.from(container.querySelector('[data-testid="conversation-roster"] > span')?.children ?? []);
    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      // The separator ring is painted on the face (*:), so it composes above
      // the face's own avatar coin shadow instead of under it, and the slot
      // stays unpositioned so tree order decides the overlap.
      expect(classTokens(slot)).toEqual(
        expect.arrayContaining(["*:ring-1", "*:ring-white", "dark:*:ring-[var(--color-studio-dark-panel)]"]),
      );
      expect(classTokens(slot).filter((token) => /^(relative|absolute|z-|ring-|shadow-)/.test(token))).toEqual([]);
      expectAvatarCoinLightEdge(slot.firstElementChild);
    }
    expect(slots[1]?.firstElementChild?.hasAttribute("data-octo-coin")).toBe(true);
  });

  it("keeps people round and draws every AI as a tile, each slot in its face's shape", async () => {
    await renderRoster([human("user-peer", "Ada")], [agent("octo", "Octo", "octo"), agent("reviewer", "Reviewer", "reviewer")]);
    const slots = Array.from(container.querySelector('[data-testid="conversation-roster"] > span')?.children ?? []);
    const [person, octo, reviewer] = slots;
    // One rule for faces: the separator ring follows each face's own shape.
    expect(classTokens(person)).toContain("rounded-full");
    expectPersonCircle(person?.firstElementChild);
    for (const slot of [octo, reviewer]) {
      expect(classTokens(slot)).toContain(AI_TILE_SHAPE_CLASS);
      expect(classTokens(slot)).not.toContain("rounded-full");
      expectAiTile(slot?.firstElementChild);
    }
    expect(reviewer?.firstElementChild?.textContent).toBe("R");
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

  it("retains credential warnings and a usable target in a compact header", async () => {
    await act(async () => root.render(
      <ConversationRoster humans={[human("user-self", "Taylor", true)]}
        agents={[agent("octo", "Octo", "octo"), agent("scout", "Scout", "scout")]}
        placement="header" maxAvatars={2} hasCredentialWarning />,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="conversation-roster"]')!;
    expect(trigger.title).toBe("Participants");
    expect(container.querySelector('[data-testid="conversation-roster-overflow"]')?.textContent).toBe("+1");
    expect(container.querySelector('[data-testid="conversation-roster-warning"]')).not.toBeNull();
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

  it("renders a persistent open-participants button when there are no members", async () => {
    await renderRoster([], []);
    const trigger = container.querySelector('[data-testid="conversation-roster"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Open participants");
    // No avatar stack in the empty state.
    expect(
      trigger?.querySelectorAll(
        '[data-testid="chat-avatar-human"], [data-testid="chat-avatar-assistant"]',
      ).length,
    ).toBe(0);
  });

  it("toggles the drawer from the empty-state button too", async () => {
    await renderRoster([], []);
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
  });

});
