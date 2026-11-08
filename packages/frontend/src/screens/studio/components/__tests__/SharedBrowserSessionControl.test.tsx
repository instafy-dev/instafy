// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedBrowserSessionControl } from "../SharedBrowserSessionControl";

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
});
