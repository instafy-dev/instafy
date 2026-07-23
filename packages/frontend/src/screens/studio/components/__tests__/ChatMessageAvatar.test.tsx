// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatMessageAvatar } from "../ChatMessageAvatar";

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
});
