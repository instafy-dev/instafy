// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerInviteRoleToggle } from "../ComposerInviteAccessControls";

describe("ComposerInviteRoleToggle", () => {
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

  it("uses the shared inverse segmented control without changing its invite contract", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ComposerInviteRoleToggle
          value="viewer"
          onChange={onChange}
          viewerLabel="Read"
          builderLabel="Edit"
          testIdPrefix="composer-invite-access-role"
        />,
      );
    });

    const read = document.querySelector<HTMLLabelElement>(
      '[data-testid="composer-invite-access-role-viewer"]',
    );
    const edit = document.querySelector<HTMLLabelElement>(
      '[data-testid="composer-invite-access-role-builder"]',
    );

    expect(read?.textContent).toBe("Read");
    expect(edit?.textContent).toBe("Edit");
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Invitation access");
    expect(read?.querySelector("input")?.type).toBe("radio");
    expect(edit?.querySelector("input")?.type).toBe("radio");
    expect(read?.querySelector("input")?.checked).toBe(true);
    expect(edit?.querySelector("input")?.checked).toBe(false);
    expect(read?.classList.contains("min-h-11")).toBe(true);
    expect(read?.classList.contains("sm:pointer-fine:min-h-9")).toBe(true);
    expect(read?.className).toContain("bg-[rgba(255,255,255,0.12)]");

    await act(async () => edit?.click());
    expect(onChange).toHaveBeenCalledWith("builder");
  });
});
