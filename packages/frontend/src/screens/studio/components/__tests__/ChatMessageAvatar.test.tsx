// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatMessageAvatar } from "../ChatMessageAvatar";
import { ViewerAgentsContext } from "../viewerAgents";
import { resolveHumanAvatarColors } from "../../../../utils/humanAvatar";
import { resolveHumanChatIdentity } from "../chatHumanIdentity";
import {
  classTokens,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
  expectHatchling,
  expectPersonCircle,
} from "../../../../components/__tests__/octoCoinExpectations";

describe("ChatMessageAvatar", () => {
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

  it("renders the built-in Octo as an animatable canonical inline mark", async () => {
    await act(async () => {
      root.render(
        <ChatMessageAvatar
          kind="assistant"
          agent={{ handle: "octo", avatarSeed: "octo" }}
          motion="thinking"
        />,
      );
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".octo-mark")?.getAttribute("data-octo-motion")).toBe(
      "thinking",
    );
  });

  it.each(["2xs", "xs", "sm", "lg"] as const)(
    "draws Octo as its coin, reversed in dark, under any row's test id at %s",
    async (size) => {
      await act(async () => {
        root.render(
          <ChatMessageAvatar
            kind="assistant"
            agent={{ handle: "octo", avatarSeed: "octo" }}
            size={size}
            testId="assistant-thinking-octo-compact"
          />,
        );
      });

      expect(container.querySelector('[data-testid="chat-avatar-assistant"]')).toBeNull();
      // The face is the coin itself: no grey-bordered, shadowed shell around it.
      const face = container.querySelector('[data-testid="assistant-thinking-octo-compact"]');
      expectCanonicalOctoCoin(face);
    },
  );

  it.each([
    ["2xs", "h-6"],
    ["xs", "h-7"],
    ["sm", "h-8"],
    ["lg", "h-12"],
  ] as const)(
    "draws other agents as one of Octo's hatchlings on Octo's tile at %s",
    async (size, height) => {
      await act(async () => {
        root.render(<ChatMessageAvatar kind="assistant" agent={{ handle: "reviewer", avatarSeed: "reviewer" }} size={size} />);
      });
      const face = container.querySelector('[data-testid="chat-avatar-assistant"]');
      expect(face?.hasAttribute("data-octo-coin")).toBe(false);
      expect(face?.querySelector(".octo-mark")).toBeNull();
      // docs/Brand.md, "Octo's hatchlings": the rounded square with its inside
      // hairline and the shared coin shadow in light, the hairline its only
      // edge in dark, as Octo's; one hatchling (reviewer's seed hashes to 3),
      // no gradient and no initial.
      expect(expectHatchling(face)).toBe("3");
      expect(classTokens(face)).toContain(height);
    },
  );

  it("clips an uploaded agent picture to Octo's tile, with the face its id hashes to behind it", async () => {
    await act(async () => {
      root.render(
        <ChatMessageAvatar kind="assistant" agent={{ handle: "pia", avatarSeed: "https://images.example/pia.png", id: "agent-pia" }} />,
      );
    });
    const face = container.querySelector('[data-testid="chat-avatar-assistant"]');
    expect(face?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia.png");
    expect(expectAiTile(face)).toEqual(expect.arrayContaining(["overflow-hidden", "bg-white", "dark:bg-octo-coin-dark"]));
    expectAvatarCoinLightEdge(face);
    // agent-pia is 6, where its handle would be 2.
    await act(async () => { face!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("6");
  });

  it("reads the face a row stamps, its agent id included, and gives an unattributed row to Octo", async () => {
    // A helper's stamp names its face.
    await act(async () => root.render(
      <ChatMessageAvatar kind="assistant" metadata={{ agent: { handle: "reading_list", avatarSeed: "hatchling:3" } }} />,
    ));
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("3");

    // A saved agent's picture that fails shows the face its id hashes to
    // (agent-pia is 6, where its handle would be 2).
    await act(async () => root.render(
      <ChatMessageAvatar kind="assistant"
        metadata={{ agent: { handle: "pia", id: "agent-pia", avatarSeed: "https://images.example/pia.png" } }} />,
    ));
    await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("6");

    await act(async () => root.render(<ChatMessageAvatar kind="assistant" metadata={{ runId: "run-1" }} />));
    expectCanonicalOctoCoin(container.querySelector('[data-testid="chat-avatar-assistant"]'));
  });

  it("prefers the identity a caller passes, such as the viewer's current profile, over the row's stamp", async () => {
    await act(async () => root.render(
      <ChatMessageAvatar kind="assistant" agent={{ handle: "pia", avatarSeed: "hatchling:7" }}
        metadata={{ agent: { handle: "pia", avatarSeed: "hatchling:2" } }} />,
    ));
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("7");
  });

  it("draws the viewer's own saved agent from its current profile, and every other AI as stamped", async () => {
    // The viewer picked Pia's face again after these rows were written.
    const viewerAgents = new Map([["own-pia", { avatarSeed: "hatchling:7" }]]);
    const face = () => expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'));
    const renderIn = async (avatar: JSX.Element) => act(async () => root.render(
      <ViewerAgentsContext.Provider value={viewerAgents}>{avatar}</ViewerAgentsContext.Provider>,
    ));
    await renderIn(<ChatMessageAvatar kind="assistant" metadata={{ agent: { handle: "pia", id: "own-pia", avatarSeed: "hatchling:2" } }} />);
    expect(face()).toBe("7");
    // The speaker label hands over the row's stamp and its id.
    await renderIn(<ChatMessageAvatar kind="assistant" agent={{ handle: "pia", avatarSeed: "hatchling:2", id: "own-pia" }} />);
    expect(face()).toBe("7");
    // Another member's @pia keeps its own stamp, as does a helper.
    await renderIn(<ChatMessageAvatar kind="assistant" metadata={{ agent: { handle: "pia", id: "peer-pia", avatarSeed: "hatchling:2" } }} />);
    expect(face()).toBe("2");
    await renderIn(<ChatMessageAvatar kind="assistant" metadata={{ agent: { handle: "pia", avatarSeed: "hatchling:4" } }} />);
    expect(face()).toBe("4");
  });

  it("draws an AI the caller knows only from text as the hollow face, unless it is Octo", async () => {
    await act(async () => root.render(
      <ChatMessageAvatar kind="assistant" agent={{ handle: "zed", avatarSeed: "zed", textOnly: true }} size="lg" />,
    ));
    expect(expectHatchling(container.querySelector('[data-testid="chat-avatar-assistant"]'))).toBe("unknown");
    await act(async () => root.render(
      <ChatMessageAvatar kind="assistant" agent={{ handle: "octo", avatarSeed: "octo", textOnly: true }} size="lg" />,
    ));
    expectCanonicalOctoCoin(container.querySelector('[data-testid="chat-avatar-assistant"]'));
  });

  it("keeps a person's face round, edged by the shared coin shadow in light and its small shadow in dark", async () => {
    await act(async () => root.render(<ChatMessageAvatar kind="human" seed="person-id" label="Alex Person" />));
    const face = container.querySelector('[data-testid="chat-avatar-human"]');
    expectPersonCircle(face);
    const tokens = expectAvatarCoinLightEdge(face);
    expect(tokens).toContain("dark:shadow-sm");
  });

  it("never gives a hatchling Octo's motion", async () => {
    await act(async () => root.render(
      <ChatMessageAvatar kind="assistant" agent={{ handle: "reviewer", avatarSeed: "reviewer" }} motion="thinking" scrollReactive />,
    ));
    expect(container.querySelector("[data-octo-motion]")).toBeNull();
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
  });

  it("never applies Octo motion to a custom image avatar", async () => {
    await act(async () => {
      root.render(
        <ChatMessageAvatar
          kind="assistant"
          agent={{
            handle: "reviewer",
            avatarSeed:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          }}
          motion="thinking"
        />,
      );
    });

    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector(".octo-mark")).toBeNull();
  });

  it("uses the same stable human fallback in transcript and compact presence sizes", async () => {
    await act(async () => root.render(<>
      <ChatMessageAvatar kind="human" seed="person-id" label="Alex Person" />
      <ChatMessageAvatar kind="human" seed="person-id" label="Alex Person" size="2xs" />
    </>));
    const avatars = container.querySelectorAll<HTMLElement>('[data-testid="chat-avatar-human"]');
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      expect(avatar.textContent).toBe("AP");
      expect(avatar.style.backgroundImage).toBe("");
      expect(avatar.style.getPropertyValue("--human-avatar-background")).toBe(resolveHumanAvatarColors("person-id").background);
    }
  });

  it("seeds human colors by author ID rather than a changing client session", () => {
    const message = { id: "message", role: "user" as const, content: "Hello", timestamp: 1 };
    const known = resolveHumanChatIdentity({ ...message, authorId: "known-user", metadata: { client: { sessionId: "browser-session" } } }, new Map());
    expect(known.avatarSeed).toBe("known-user");
    const unknown = resolveHumanChatIdentity({ ...message, metadata: { client: { sessionId: "browser-session" } } }, new Map());
    expect(unknown.avatarSeed).toBeNull();
    expect(unknown.groupIdentity).toBe("user:browser-session");
  });

  it("prefers a supplied human photo and keeps generic labels out of initials", async () => {
    await act(async () => root.render(<ChatMessageAvatar kind="human" seed="person-id" label="You" />));
    expect(container.querySelector('[data-testid="chat-avatar-human"]')?.textContent).toBe("");
    await act(async () => root.render(<ChatMessageAvatar kind="human" seed="person-id" label="You" avatarUrl="https://example.test/person.png" />));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/person.png");
  });
});
