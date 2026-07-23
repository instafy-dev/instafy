// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandOutputBlock } from "../CommandOutputBlock";

describe("CommandOutputBlock", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("can start collapsed for read-only run traces", async () => {
    await act(async () => {
      root.render(
        <CommandOutputBlock
          command="bash -lc instafy conversation create"
          output={'{\n  "conversationId": "thread-1"\n}'}
          collapsible
          defaultOutputVisible={false}
          compact
          subtle
        />,
      );
    });

    expect(container.textContent).toContain("Output hidden - expand to inspect.");
    expect(container.textContent).not.toContain('"conversationId"');

    const toggle = container.querySelector('button[aria-label="Show command output"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });

    expect(container.textContent).toContain('"conversationId"');
    expect(container.querySelector('button[aria-label="Hide command output"]')).not.toBeNull();
  });
});
