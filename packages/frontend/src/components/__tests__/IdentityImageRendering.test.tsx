// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "../AgentAvatar";
import { SpaceIdentity } from "../SpaceIdentity";
import { normalizeIdentityImageSrc } from "../../utils/identityImageSrc";

describe("identity image rendering", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const render = async (element: ReactNode) => { await act(async () => root.render(element)); };

  it("encodes URL metacharacters without changing existing escapes or query separators", () => {
    expect(normalizeIdentityImageSrc('https://images.example/a%2Fb x.png?q="<tag>"&token=a%2Bb'))
      .toBe("https://images.example/a%2Fb%20x.png?q=%22%3Ctag%3E%22&token=a%2Bb");
    for (const src of ["/assets/octo.svg", "blob:https://app.example/preview", "data:image/png;base64,cGljdHVyZQ=="])
      expect(normalizeIdentityImageSrc(src)).toBe(src);
  });
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://example.test/\ud800", null])("rejects invalid image source %s", src => {
    expect(normalizeIdentityImageSrc(src)).toBeNull();
  });

  const avatars = [
    ["bot", (src: string) => <AgentAvatar agent={{ handle: "reviewer", displayName: "<Review>" }} imageSrc={src} />],
    ["space", (src: string) => <SpaceIdentity name="<Review>" avatarUrl={src} />],
  ] as const;
  it.each(avatars)("renders %s upload previews as URLs, falls back safely, and accepts a replacement", async (_kind, avatar) => {
    await render(avatar('blob:https://app.example/preview"><script>alert(1)</script>'));
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("%22%3E%3Cscript%3E");
    expect(img.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    await act(async () => { img.dispatchEvent(new Event("error")); });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("<");
    expect(container.querySelector("script")).toBeNull();
    await render(avatar("https://images.example/replacement.png"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://images.example/replacement.png");
  });
});
