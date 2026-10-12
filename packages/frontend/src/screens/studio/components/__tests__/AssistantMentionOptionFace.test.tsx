// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
} from "../../../../components/__tests__/octoCoinExpectations";
import { MentionOptionFace, type MentionAgentProfile } from "../chat-input/AssistantMentionsPlugin";

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
  ])("draws %s as Octo's coin, not the static avatar file", async (_name, entry) => {
    await act(async () => root.render(<MentionOptionFace option={entry} agentProfilesByHandle={noProfiles} />));
    expect(container.querySelector("img")).toBeNull();
    const coin = container.firstElementChild;
    expectCanonicalOctoCoin(coin);
    expect(coin?.getAttribute("class")).toContain("h-6 w-6");
  });

  it("keeps a custom agent's generated face", async () => {
    await act(async () =>
      root.render(<MentionOptionFace option={option("agent", "@ben", "Ben")} agentProfilesByHandle={noProfiles} />));
    expect(container.querySelector("[data-octo-coin]")).toBeNull();
    expect(container.textContent).toBe("B");
    // Light: the shared coin shadow, no grey border; dark keeps its hairline.
    const tokens = expectAvatarCoinLightEdge(container.firstElementChild);
    expect(tokens).toEqual(expect.arrayContaining(["dark:border", "dark:border-slate-700", "dark:shadow-sm"]));
  });

  it("gives a person's face the same light edge, with the photo clipped inside it", async () => {
    await act(async () =>
      root.render(
        <MentionOptionFace
          option={{ kind: "user", token: "ada", label: "Ada", userId: "u-ada", displayName: "Ada Person" }}
          agentProfilesByHandle={noProfiles}
        />,
      ));
    const shell = container.firstElementChild;
    expectAvatarCoinLightEdge(shell);
    expect(shell?.getAttribute("class")).toContain("overflow-hidden");
    expect(shell?.querySelector("[data-human-avatar]")?.textContent).toBe("AP");
  });
});
