// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRoster } from "../ConversationRoster";
import {
  classTokens,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
  expectHatchling,
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
    expect(expectHatchling(reviewer?.firstElementChild)).toBe("3");
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
    // Each seed is its own hatchling (seed-scout 4, seed-medic 8), not the
    // hatchling of the handle beside it.
    expect(agentAvatars.slice(1).map(expectHatchling)).toEqual(["4", "8"]);
  });

  it("keys AIs by agent id and folds a repeated face into the +N", async () => {
    // Two of the viewer's agents that wear one hatchling, a picture and Octo.
    await renderRoster(
      [human("user-self", "Taylor", true)],
      [
        agent("octo", "Octo", "octo"),
        { agentId: "agent-scout", handle: "scout", displayName: "Scout", avatarSeed: "hatchling:6" },
        { agentId: "agent-medic", handle: "medic", displayName: "Medic", avatarSeed: "hatchling:6" },
        { agentId: "agent-pia", handle: "pia", displayName: "Pia", avatarSeed: "/pia.png" },
      ],
    );
    const trigger = container.querySelector('[data-testid="conversation-roster"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Conversation members (5)");
    const agentAvatars = Array.from(trigger?.querySelectorAll('[data-testid="chat-avatar-assistant"]') ?? []);
    expect(agentAvatars).toHaveLength(3);
    expect(expectHatchling(agentAvatars[1])).toBe("6");
    expect(agentAvatars[2]?.querySelector("img")?.getAttribute("src")).toBe("/pia.png");
    // Medic is counted, not drawn beside its twin.
    expect(container.querySelector('[data-testid="conversation-roster-overflow"]')?.textContent).toBe("+1");

    // Two people's agents can share a handle; the id tells them apart.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await renderRoster([], [
        { agentId: "own-pia", handle: "pia", displayName: "Pia", avatarSeed: "hatchling:2" },
        { agentId: "peer-pia", handle: "pia", displayName: "Pia", avatarSeed: "hatchling:5" },
      ]);
      const faces = Array.from(container.querySelectorAll('[data-testid="chat-avatar-assistant"]'));
      expect(faces.map(expectHatchling)).toEqual(["2", "5"]);
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("draws an AI the viewer knows only by its handle with the hollow face, and folds a second one into the +N", async () => {
    await renderRoster(
      [human("user-self", "Taylor", true)],
      [
        { ...agent("octo", "Octo", "octo"), textOnly: true },
        { ...agent("kimbot", "@kimbot", "kimbot"), agentId: null, textOnly: true },
        { ...agent("zed", "@zed", "zed"), agentId: null, textOnly: true },
      ],
    );
    const faces = Array.from(container.querySelectorAll('[data-testid="chat-avatar-assistant"]'));
    expectCanonicalOctoCoin(faces[0]);
    expect(faces.slice(1).map(expectHatchling)).toEqual(["unknown"]);
    expect(container.querySelector('[data-testid="conversation-roster-overflow"]')?.textContent).toBe("+1");
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
