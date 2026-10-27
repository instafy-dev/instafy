// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatMessageAvatar } from "../ChatMessageAvatar";
import { resolveHumanAvatarColors } from "../../../../utils/humanAvatar";
import { resolveHumanChatIdentity } from "../chatHumanIdentity";
import {
  AI_TILE_EDGE_TOKENS,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
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

  it.each(["2xs", "xs", "sm", "lg"] as const)(
    "draws other agents as the AI tile, edged like Octo's, at %s",
    async (size) => {
      await act(async () => {
        root.render(<ChatMessageAvatar kind="assistant" agent={{ handle: "reviewer", avatarSeed: "reviewer" }} size={size} />);
      });
      const face = container.querySelector('[data-testid="chat-avatar-assistant"]');
      expect(face?.hasAttribute("data-octo-coin")).toBe(false);
      expect(face?.querySelector(".octo-mark")).toBeNull();
      expect(face?.textContent).toBe("R");
      // One rule for faces: the rounded square with its inside hairline and
      // the shared coin shadow in light; in dark the hairline is its only
      // edge, as it is Octo's (no border, no small shadow).
      const tokens = expectAiTile(face);
      expectAvatarCoinLightEdge(face);
      expect(tokens.filter((token) => /^dark:(border|shadow)/.test(token))).toEqual([]);
      expect(tokens.filter((token) => token.startsWith("dark:outline"))).toEqual(
        AI_TILE_EDGE_TOKENS.filter((token) => token.startsWith("dark:")),
      );
    },
  );

  it("clips an uploaded agent picture to the AI tile", async () => {
    await act(async () => {
      root.render(
        <ChatMessageAvatar kind="assistant" agent={{ handle: "pia", avatarSeed: "https://images.example/pia.png" }} />,
      );
    });
    const face = container.querySelector('[data-testid="chat-avatar-assistant"]');
    expect(face?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia.png");
    expect(expectAiTile(face)).toEqual(expect.arrayContaining(["overflow-hidden", "bg-white", "dark:bg-slate-900"]));
  });

  it("keeps a person's face round, edged by the shared coin shadow in light and its small shadow in dark", async () => {
    await act(async () => root.render(<ChatMessageAvatar kind="human" seed="person-id" label="Alex Person" />));
    const face = container.querySelector('[data-testid="chat-avatar-human"]');
    expectPersonCircle(face);
    const tokens = expectAvatarCoinLightEdge(face);
    expect(tokens).toContain("dark:shadow-sm");
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
