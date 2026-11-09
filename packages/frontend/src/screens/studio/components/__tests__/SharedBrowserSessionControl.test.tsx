// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedBrowserSessionControl } from "../SharedBrowserSessionControl";

const clipboard = vi.hoisted(() => ({ write: vi.fn<(value: string) => Promise<void>>() }));
vi.mock("../../../../runtime/runtimeMenuShared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../runtime/runtimeMenuShared")>()),
  writeClipboardText: clipboard.write,
}));

type Props = ComponentProps<typeof SharedBrowserSessionControl>;

describe("Browser options' Advanced row", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(overrides: Partial<Props> = {}) {
    await act(async () => {
      root.render(
        <SharedBrowserSessionControl
          runtimeId="runtime-1"
          resumeUrl="https://studio.example.test/studio?browserRuntimeId=runtime-1"
          open
          busy={false}
          candidates={[{ runtimeId: "runtime-1", originId: "origin-1", endpoint: null, mode: "lazy" }]}
          error={null}
          canStart={false}
          onOpenChange={vi.fn()}
          onChoose={vi.fn()}
          onStart={vi.fn()}
          onRefresh={vi.fn()}
          {...overrides}
        />,
      );
    });
  }

  const advanced = () => document.querySelector<HTMLDetailsElement>('[data-testid="shared-browser-session-control"] details')!;

  it("opens by itself when a session must be chosen or the sessions could not be read, and never closes under the person", async () => {
    await render();
    expect(advanced().querySelector("summary")?.textContent).toBe("Advanced");
    expect(advanced().open).toBe(false);
    await render({ error: "Could not refresh sessions. Your current browser is still available." });
    expect(advanced().open).toBe(true);
    expect(advanced().textContent).toContain("Could not refresh sessions.");
    // The person refreshed from inside it: it stays open once the error is gone.
    await render();
    expect(advanced().open).toBe(true);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ selectionRequired: true, error: "Choose a session to resume." });
    expect(advanced().open).toBe(true);
  });

  const RESUME_URL = "https://studio.example.test/studio?browserRuntimeId=runtime-1";
  const copyButton = () => [...advanced().querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
    .find((element) => element.textContent?.trim() === "Copy resume link") ?? null;
  const linkBox = () => advanced().querySelector<HTMLInputElement>('input[aria-label="Shared Browser resume link"]');

  // A local test, Nov 9: Advanced showed the resume link as an address, with
  // the space's and the session's ids in it, under "Copy resume link".
  it("offers the resume link to copy and shows no address, unless copying it failed", async () => {
    await render();
    advanced().open = true;
    expect(copyButton()).not.toBeNull();
    expect(linkBox()).toBeNull();
    expect(advanced().textContent).not.toContain("browserRuntimeId");

    clipboard.write.mockResolvedValueOnce(undefined);
    await act(async () => copyButton()!.click());
    expect(clipboard.write).toHaveBeenLastCalledWith(RESUME_URL);
    expect(advanced().querySelector('[role="status"]')?.textContent).toBe("Resume link copied.");
    expect(linkBox()).toBeNull();

    // The clipboard refused: the link shows, chosen, to copy by hand.
    clipboard.write.mockRejectedValueOnce(new Error("denied"));
    await act(async () => copyButton()!.click());
    expect(advanced().querySelector('[role="status"]')?.textContent).toBe("Could not copy. Select and copy the link below.");
    expect(linkBox()?.value).toBe(RESUME_URL);
    expect(document.activeElement).toBe(linkBox());
  });

  // The address is for that one failed copy: once the person closes Browser
  // options, a later opening starts as any other does, with Advanced closed,
  // no address, no old status and the focus left where it was.
  it("shows the link only in the opening whose copy failed", async () => {
    await render();
    advanced().open = true;
    clipboard.write.mockRejectedValueOnce(new Error("denied"));
    await act(async () => copyButton()!.click());
    expect(linkBox()?.value).toBe(RESUME_URL);

    await render({ open: false });
    for (let opening = 0; opening < 2; opening += 1) {
      await render({ open: true });
      expect(advanced().open).toBe(false);
      expect(linkBox()).toBeNull();
      expect(advanced().querySelector('[role="status"]')).toBeNull();
      expect(document.activeElement?.tagName).not.toBe("INPUT");
      await render({ open: false });
    }

    // A new failure shows the link again, in its own opening.
    await render({ open: true });
    advanced().open = true;
    clipboard.write.mockRejectedValueOnce(new Error("denied"));
    await act(async () => copyButton()!.click());
    expect(linkBox()?.value).toBe(RESUME_URL);
    expect(document.activeElement).toBe(linkBox());
  });
});
