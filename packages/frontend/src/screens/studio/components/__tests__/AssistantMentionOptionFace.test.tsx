// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
  expectPersonCircle,
} from "../../../../components/__tests__/octoCoinExpectations";
import {
  MentionOptionFace,
  MentionOptionDescription,
  type MentionAgentProfile,
} from "../chat-input/AssistantMentionsPlugin";

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

  it("draws a custom agent's generated face in the AI tile", async () => {
    await act(async () =>
      root.render(<MentionOptionFace option={option("agent", "@ben", "Ben")} agentProfilesByHandle={noProfiles} />));
    expect(container.querySelector("[data-octo-coin]")).toBeNull();
    expect(container.textContent).toBe("B");
    // The shell clips the gradient to the AI tile: the shared coin shadow in
    // light, the inside hairline as its only edge in dark.
    const tokens = expectAiTile(container.firstElementChild);
    expectAvatarCoinLightEdge(container.firstElementChild);
    expect(tokens).toContain("overflow-hidden");
    expect(tokens.filter((token) => /^dark:(border|shadow)/.test(token))).toEqual([]);
  });

  it("clips an agent's uploaded picture to the AI tile", async () => {
    const profiles = new Map<string, MentionAgentProfile>([
      ["pia", { handle: "pia", displayName: "Pia", avatarUrl: "https://images.example/pia.png" }],
    ]);
    await act(async () =>
      root.render(<MentionOptionFace option={option("agent", "@pia", "Pia")} agentProfilesByHandle={profiles} />));
    const shell = container.firstElementChild;
    expect(shell?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia.png");
    expect(expectAiTile(shell)).toContain("overflow-hidden");
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
