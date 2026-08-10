// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRoster } from "../ConversationRoster";
import type {
  ConversationRosterAgent,
  ConversationRosterHuman,
} from "../conversationRosterMembers";

vi.mock("react-aria-components", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...original,
    DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const popoverPlacements: unknown[] = [];

vi.mock("../../../../components/aria/StudioPopover", () => ({
  StudioDialogPopover: ({
    children,
    placement,
  }: {
    children: ReactNode;
    placement?: unknown;
  }) => {
    popoverPlacements.push(placement);
    return <div>{children}</div>;
  },
}));

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
    popoverPlacements.length = 0;
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderRoster(
    humans: ConversationRosterHuman[],
    agents: ConversationRosterAgent[],
  ) {
    await act(async () => {
      root.render(<ConversationRoster humans={humans} agents={agents} />);
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
    expect(stackedAvatars?.[1]?.getAttribute("data-testid")).toBe("chat-avatar-human");
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
    const stackedAvatars = trigger?.querySelectorAll(
      '[data-testid="chat-avatar-human"], [data-testid="chat-avatar-assistant"]',
    );
    expect(stackedAvatars?.length).toBe(5);
    expect(
      container.querySelector('[data-testid="conversation-roster-overflow"]')?.textContent,
    ).toBe("+2");
  });

  it("lists member names in the popover with an AI listening descriptor", async () => {
    await renderRoster(
      [human("user-self", "Taylor", true), human("user-peer", "Teammate")],
      [agent("octo", "Octo", "octo"), agent("scout", "Scout", "seed-scout")],
    );

    const popover = container.querySelector('[data-testid="conversation-roster-popover"]');
    expect(popover).not.toBeNull();

    const humanRows = popover?.querySelectorAll('[data-testid="conversation-roster-human"]');
    expect(humanRows?.length).toBe(2);
    expect(humanRows?.[0]?.textContent).toContain("Taylor");
    expect(humanRows?.[0]?.textContent).toContain("You");
    expect(humanRows?.[1]?.textContent).toContain("Teammate");

    const agentRows = popover?.querySelectorAll('[data-testid="conversation-roster-agent"]');
    expect(agentRows?.length).toBe(2);
    expect(agentRows?.[0]?.textContent).toContain("Octo");
    expect(agentRows?.[0]?.textContent).toContain("AI · listening");
    expect(agentRows?.[1]?.textContent).toContain("Scout");
    expect(agentRows?.[1]?.textContent).toContain("AI · listening");
  });

  it("renders each agent with its own avatar seed instead of a hardcoded Octo face", async () => {
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

    // The default assistant keeps the canonical Octo mark; custom agents get
    // deterministic per-seed gradients that must differ from one another.
    expect(agentAvatars[0]?.querySelector("svg, img")).not.toBeNull();
    const scoutStyle = agentAvatars[1]?.getAttribute("style") ?? "";
    const medicStyle = agentAvatars[2]?.getAttribute("style") ?? "";
    expect(scoutStyle).toContain("linear-gradient");
    expect(medicStyle).toContain("linear-gradient");
    expect(scoutStyle).not.toBe(medicStyle);
  });

  it("renders nothing when there are no members", async () => {
    await renderRoster([], []);
    expect(container.querySelector('[data-testid="conversation-roster"]')).toBeNull();
  });

  it("keeps the trigger ambient: no panel background, border, shadow or blur", async () => {
    await renderRoster([human("user-self", "Taylor", true)], [agent("octo", "Octo", "octo")]);

    const trigger = container.querySelector('[data-testid="conversation-roster"]');
    const triggerClass = trigger?.getAttribute("class") ?? "";
    expect(triggerClass).toContain("bg-transparent");
    expect(triggerClass).toContain("border-0");
    expect(triggerClass).toContain("shadow-none");
    expect(triggerClass).not.toContain("backdrop-blur");
    expect(triggerClass).not.toContain("bg-white/85");
    expect(triggerClass).not.toContain("shadow-sm");
    // Hover is only the shared ghost variant's subtle wash — the roster adds no
    // competing hover background of its own.
    expect(triggerClass).toContain("hover:bg-slate-100 ");

    // The only ring left is the hairline that separates overlapping faces, and
    // it is painted in the chat surface's own background in both themes (white
    // / --color-studio-dark-panel), not the workspace canvas.
    const ringWrapper = trigger?.querySelector('[data-testid="chat-avatar-human"]')?.parentElement;
    const ringClass = ringWrapper?.getAttribute("class") ?? "";
    expect(ringClass).toContain("ring-1");
    expect(ringClass).toContain("ring-white");
    expect(ringClass).toContain("dark:ring-[var(--color-studio-dark-panel)]");
    expect(ringClass).not.toContain("dark:ring-[var(--color-studio-dark-canvas)]");
    expect(ringClass).not.toContain("ring-2");
  });

  it("opens the popover downward, away from the conversation top edge", async () => {
    await renderRoster([human("user-self", "Taylor", true)], [agent("octo", "Octo", "octo")]);

    expect(popoverPlacements).toContain("bottom end");
  });
});
