// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classTokens,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
  expectHatchling,
  expectPersonCircle,
} from "../../../../components/__tests__/octoCoinExpectations";
import { resolveAiFace } from "../../../../utils/aiFace";
import { ConversationRoster } from "../ConversationRoster";
import {
  MentionOptionFace,
  MentionOptionDescription,
  type MentionAgentProfile,
} from "../chat-input/AssistantMentionsPlugin";
import { resolveConversationRosterAgents } from "../conversationRosterMembers";

describe("MentionOptionFace", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const noProfiles = new Map<string, MentionAgentProfile>();
  const option = (kind: "assistant" | "agent", token: string, label: string) =>
    ({ kind, token, label, userId: null, displayName: null });

  it.each([
    ["the built-in @octo option", option("assistant", "@octo", "Octo")],
    ["an @octo agent option without a picture", option("agent", "@octo", "Octo")],
  ])("draws %s as Octo's tile, not the static avatar file", async (_name, entry) => {
    await act(async () => root.render(<MentionOptionFace option={entry} agentProfilesByHandle={noProfiles} />));
    expect(container.querySelector("img")).toBeNull();
    const coin = container.firstElementChild;
    expectCanonicalOctoCoin(coin);
    expect(coin?.getAttribute("class")).toContain("h-6 w-6");
  });

  it.each([
    ["a conversation's handle the viewer has no agent for", option("agent", "@zed", "Zed")],
    ["the same handle in capitals", option("agent", "@ZED", "Zed")],
    ["a built-in assistant other than Octo", option("assistant", "@scribe", "Scribe")],
  ])("draws %s as the hollow face: the picker knows the AI only by name", async (_name, entry) => {
    await act(async () => root.render(<MentionOptionFace option={entry} agentProfilesByHandle={noProfiles} />));
    expect(container.querySelector("[data-octo-coin]")).toBeNull();
    // Its numbered face is the one its rows wear in a chat, which the picker
    // cannot know. Octo's tile, with the shared coin shadow in light and the
    // inside hairline as its only edge in dark.
    const face = container.firstElementChild;
    expect(expectHatchling(face)).toBe("unknown");
    expect(classTokens(face)).toEqual(expect.arrayContaining(["h-6", "w-6", "overflow-hidden"]));
  });

  it("draws a conversation's AI the viewer has no saved agent for as the header roster does", async () => {
    // The chat names @kimbot, and the viewer has no agent of that name: the
    // picker and the roster (and the drawer, which lists the roster's AIs)
    // both know it only by name.
    const [kimbot] = resolveConversationRosterAgents({ agentHandles: ["kimbot"], agentByHandle: new Map() });
    await act(async () =>
      root.render(
        <>
          <MentionOptionFace option={option("agent", "@kimbot", "Kimbot")} agentProfilesByHandle={noProfiles} />
          <ConversationRoster agents={[kimbot!]} humans={[]} />
        </>,
      ));
    expect(expectHatchling(container.firstElementChild)).toBe("unknown");
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("unknown");
  });

  it("draws a saved agent's seed with its @ and case ignored, as the transcript draws it", async () => {
    // An older profile seeded "@Ben": the picker's face is the transcript's
    // ben, 3, not the hash of the raw "@Ben".
    const profiles = new Map<string, MentionAgentProfile>([
      ["ben", { id: "agent-ben", handle: "ben", displayName: "Ben", avatarSeed: "@Ben" }],
    ]);
    await act(async () =>
      root.render(<MentionOptionFace option={option("agent", "@ben", "Ben")} agentProfilesByHandle={profiles} />));
    expect(expectHatchling(container.firstElementChild)).toBe("3");
    expect(resolveAiFace({ handle: "ben", avatarSeed: "ben" })).toMatchObject({ kind: "hatchling", n: 3 });
  });

  it("draws the viewer's saved agent as its profile has it", async () => {
    const profiles = new Map<string, MentionAgentProfile>([
      ["pia", { id: "agent-pia", handle: "pia", displayName: "Pia", avatarSeed: "hatchling:7" }],
    ]);
    await act(async () =>
      root.render(<MentionOptionFace option={option("agent", "@pia", "Pia")} agentProfilesByHandle={profiles} />));
    expect(expectHatchling(container.firstElementChild)).toBe("7");
  });

  it("clips an agent's uploaded picture to the AI tile, and shows the face behind it if it fails", async () => {
    const profiles = new Map<string, MentionAgentProfile>([
      ["pia", { id: "agent-pia", handle: "pia", displayName: "Pia", avatarUrl: "https://images.example/pia.png" }],
    ]);
    await act(async () =>
      root.render(<MentionOptionFace option={option("agent", "@pia", "Pia")} agentProfilesByHandle={profiles} />));
    const shell = container.firstElementChild;
    expect(shell?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia.png");
    expect(expectAiTile(shell)).toContain("overflow-hidden");
    expectAvatarCoinLightEdge(shell);
    // Behind it, the face its id hashes to (agent-pia is 6), as on every
    // other surface that knows the agent.
    await act(async () => { shell!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(expectHatchling(container.firstElementChild)).toBe("6");
  });

  it("keeps a person's face round, with the same light edge and the photo clipped inside it", async () => {
    await act(async () =>
      root.render(
        <MentionOptionFace
          option={{ kind: "user", token: "ada", label: "Ada", userId: "u-ada", displayName: "Ada Person" }}
          agentProfilesByHandle={noProfiles}
        />,
      ));
    const shell = container.firstElementChild;
    expectPersonCircle(shell);
    expectAvatarCoinLightEdge(shell);
    expect(shell?.getAttribute("class")).toContain("overflow-hidden");
    expectPersonCircle(shell?.querySelector("[data-human-avatar]"));
    expect(shell?.querySelector("[data-human-avatar]")?.textContent).toBe("AP");
  });
});

describe("MentionOptionDescription", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["Octo", { kind: "assistant", label: "Octo" }],
    ["a saved agent", { kind: "agent", label: "Pia" }],
  ] as const)("follows %s's name with the AI tag, read as \", AI\"", async (_name, entry) => {
    await act(async () => root.render(<MentionOptionDescription option={entry} />));
    const tag = container.querySelector('[data-testid="ai-tag"]');
    expect(tag?.textContent).toBe(", AI");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(", ");
    expect(container.textContent).toBe(`${entry.label}, AI`);
  });

  it("never tags a person", async () => {
    await act(async () => root.render(<MentionOptionDescription option={{ kind: "user", label: "Ada Person" }} />));
    expect(container.querySelector('[data-testid="ai-tag"]')).toBeNull();
    expect(container.textContent).toBe("Ada Person");
  });
});
