// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classTokens,
  expectAiTile,
  expectCanonicalOctoCoin,
  expectHatchling,
} from "../../../../components/__tests__/octoCoinExpectations";
import { AI_TILE_SHAPE_CLASS } from "../../../../components/OctoCoin";
import { AssistantAvatarPopover } from "../AssistantAvatarPopover";
import { AssistantSpeakerIdentityLabel } from "../AssistantSpeakerIdentityPill";
import { ViewerAgentsContext } from "../viewerAgents";

// One rule for faces (docs/Brand.md): the speaker identity draws an AI as its
// rounded-square tile, so everything that hugs the face (the profile button's
// focus ring) follows the tile, and the face's accessible name says it is an AI.
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

  // Local test, Oct 31: on a phone the speaker read "octo" above replies
  // that say "Octo", as Studio names it everywhere else.
  it.each([
    ["Octo", "octo", "Octo"],
    ["a saved agent", "reviewer", "reviewer"],
  ])("names %s as Studio does, names its profile button as an AI and shapes its focus ring like the tile", async (_name, handle, shown) => {
    await act(async () => root.render(<AssistantSpeakerIdentityLabel handle={handle} />));
    expect(container.querySelector('[data-testid="chat-speaker-name"]')?.textContent).toBe(shown);
    const button = container.querySelector('[data-testid="chat-speaker-agent-profile"]');
    expect(button?.getAttribute("aria-label")).toBe(`View profile for ${shown}, AI`);
    expect(classTokens(button)).toContain(AI_TILE_SHAPE_CLASS);
    expect(classTokens(button)).not.toContain("rounded-full");
    const face = button?.firstElementChild;
    if (handle === "octo") expectCanonicalOctoCoin(face);
    else expectAiTile(face);
    // The label never carries the AI tag: the transcript's speaker line is a
    // thread row, where the tile alone says it.
    expect(container.querySelector('[data-testid="ai-tag"]')).toBeNull();
  });

  it("draws the viewer's own saved agent in the label as the gutter does, by the row's agent id", async () => {
    // The viewer picked Pia's face again after the row was stamped.
    await act(async () => root.render(
      <ViewerAgentsContext.Provider value={new Map([["own-pia", { avatarSeed: "hatchling:7" }]])}>
        <AssistantSpeakerIdentityLabel handle="pia" agentIdentity={{ handle: "pia", avatarSeed: "hatchling:2", id: "own-pia" }} />
      </ViewerAgentsContext.Provider>,
    ));
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("7");
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
});
