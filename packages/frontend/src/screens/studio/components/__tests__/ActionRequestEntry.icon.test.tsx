/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { ActionRequestEntry } from "../ActionRequestEntry";

describe("an action card's icon", () => {
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

  async function iconCount(icon: string) {
    const details = { testId: "card", icon, overline: "Ready to preview", title: "Site preview" };
    const message: ChatMessage = { id: "card", role: "assistant", content: "Site preview is ready to preview.", timestamp: 1,
      metadata: { messageType: "action_request", details } };
    await act(async () => root.render(<ActionRequestEntry message={message} details={details} />));
    return container.querySelectorAll('[data-testid="card"] svg').length;
  }

  // A preview card the site preview card cannot draw (an id it refuses, say)
  // falls back to the generic card, which still shows what it is.
  it("draws the preview icon", async () => {
    expect(await iconCount("preview")).toBe(1);
  });

  it("draws nothing for an icon it does not know", async () => {
    expect(await iconCount("something-else")).toBe(0);
  });
});
