// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classTokens,
  expectAiTile,
  expectCanonicalOctoCoin,
  expectPersonCircle,
} from "../../../../components/__tests__/octoCoinExpectations";
import { AI_TILE_SHAPE_CLASS } from "../../../../components/OctoCoin";
import { AssistantAvatarPopover } from "../AssistantAvatarPopover";
import {
  AssistantSpeakerIdentityLabel,
  AssistantSpeakerIdentityPill,
} from "../AssistantSpeakerIdentityPill";
import { HumanSpeakerIdentityPill } from "../chatHumanIdentity";

// One rule for faces (docs/Brand.md): the speaker identity draws an AI as its
// rounded-square tile, so everything that hugs the face (the sticky pill's
// corners, the profile button's focus ring) follows the tile, and the face's
// accessible name says it is an AI. A person's pill stays a stadium around a
// round face.
describe("assistant speaker identity faces", () => {
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
    ["Octo", "octo"],
    ["a saved agent", "reviewer"],
  ])("names %s's profile button as an AI and shapes its focus ring like the tile", async (_name, handle) => {
    await act(async () => root.render(<AssistantSpeakerIdentityLabel handle={handle} />));
    const button = container.querySelector('[data-testid="chat-speaker-agent-profile"]');
    expect(button?.getAttribute("aria-label")).toBe(`View profile for ${handle}, AI`);
    expect(classTokens(button)).toContain(AI_TILE_SHAPE_CLASS);
    expect(classTokens(button)).not.toContain("rounded-full");
    const face = button?.firstElementChild;
    if (handle === "octo") expectCanonicalOctoCoin(face);
    else expectAiTile(face);
    // The label never carries the AI tag: the transcript's speaker line is a
    // thread row, where the tile alone says it.
    expect(container.querySelector('[data-testid="ai-tag"]')).toBeNull();
  });

  it("names the transcript gutter's AI face as an AI", async () => {
    await act(async () => root.render(
      <AssistantAvatarPopover agentHandle="pia" agentAvatarSeed="https://images.example/pia.png" displayName="Pia"
        pinnedRuntimeId={null} resourcesSummary={null} runtimeLabel="Shared" runtimeState="ready" />,
    ));
    const button = container.querySelector('button[aria-label="Agent info: Pia, AI"]');
    // The button is the 32px face's own box, so the tile's own corners keep
    // its offset focus ring concentric with the tile.
    expect(classTokens(button)).toEqual(expect.arrayContaining(["h-8", "w-8", AI_TILE_SHAPE_CLASS]));
    expect(classTokens(button).filter((token) => /^rounded-(full|xl|lg)$/.test(token))).toEqual([]);
    const face = button?.querySelector('[data-testid="chat-avatar-assistant"]');
    expectAiTile(face);
    expect(face?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia.png");
  });

  it("rounds an AI's sticky pill to the tile and keeps a person's pill a stadium", async () => {
    await act(async () => root.render(
      <>
        <AssistantSpeakerIdentityPill handle="reviewer" />
        <HumanSpeakerIdentityPill avatarSeed="person-id" label="Alex Person" />
      </>,
    ));
    const aiPill = container.querySelector('[data-agent-handle="reviewer"]');
    expect(classTokens(aiPill)).toContain("rounded-xl");
    expect(classTokens(aiPill)).not.toContain("rounded-full");
    expectAiTile(aiPill?.querySelector('[data-testid="chat-avatar-assistant"]'));

    const personPill = container.querySelector('[data-testid="chat-human-speaker-pill"]');
    expect(classTokens(personPill)).toContain("rounded-full");
    expect(classTokens(personPill)).not.toContain("rounded-xl");
    expectPersonCircle(personPill?.querySelector('[data-testid="chat-avatar-human"]'));
    // Both pills keep the same shared geometry (border, padding, the 3px pull).
    const shared = (pill: Element | null) => classTokens(pill).filter((token) => !token.startsWith("rounded-") && !token.startsWith("dark:"));
    expect(shared(aiPill)).toEqual(shared(personPill));
  });
});
