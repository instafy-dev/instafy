// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HumanAvatar, type HumanAvatarProps } from "../HumanAvatar";

describe("HumanAvatar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(props: HumanAvatarProps) {
    await act(async () => root.render(<HumanAvatar {...props} />));
    return container.querySelector<HTMLElement>("[data-human-avatar]")!;
  }

  it("keeps the user's color through rename, photo selection, and removal", async () => {
    const first = await render({ userId: "stable-user", displayName: "Alex Person" });
    const colors = first.getAttribute("style");
    expect(first.textContent).toBe("AP");
    const renamed = await render({ userId: "stable-user", displayName: "Blair Teammate" });
    expect(renamed.textContent).toBe("BT");
    expect(renamed.getAttribute("style")).toBe(colors);
    const photo = await render({ userId: "stable-user", displayName: "Blair Teammate", avatarUrl: "https://example.test/avatar.png" });
    expect(photo.textContent).toBe("");
    expect(photo.querySelector("img")?.getAttribute("src")).toBe("https://example.test/avatar.png");
    expect(photo.getAttribute("style")).toBe(colors);
    const removed = await render({ userId: "stable-user", displayName: "Blair Teammate", avatarUrl: null });
    expect(removed.querySelector("img")).toBeNull();
    expect(removed.textContent).toBe("BT");
    expect(removed.getAttribute("style")).toBe(colors);
  });

  it.each([null, "Guest", "You", "email@example.test"])("uses a person icon for %s", async (displayName) => {
    const avatar = await render({ userId: "user-without-name", displayName });
    expect(avatar.textContent).toBe("");
    expect(avatar.querySelector("svg")).not.toBeNull();
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
  });

  it("preserves an explicit accessible photo preview and caller sizing", async () => {
    const avatar = await render({
      userId: "editor-user", avatarUrl: "data:image/png;base64,cGhvdG8=", photoAlt: "Profile photo preview",
      className: "h-16 w-16 text-base", "data-testid": "profile-preview",
    });
    expect(avatar.getAttribute("aria-hidden")).toBeNull();
    expect(avatar.getAttribute("data-testid")).toBe("profile-preview");
    expect(avatar.className).toContain("h-16 w-16 text-base");
    expect(avatar.querySelector("img")?.getAttribute("alt")).toBe("Profile photo preview");
  });
});
