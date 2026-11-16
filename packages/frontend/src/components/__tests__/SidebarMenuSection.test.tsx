// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarMenuSection } from "../SidebarMenuSection";
import { textTones } from "../../styles/typography";

describe("SidebarMenuSection", () => {
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

  it("labels the section in the muted tone, which reads on the rail, never the faint subtle grey", async () => {
    await act(async () => root.render(<SidebarMenuSection label="Spaces" actions={<button type="button">New space</button>} />));
    const label = container.querySelector("p")!;
    expect(label.textContent).toBe("Spaces");
    const classes = [...label.classList];
    expect(classes).toEqual(expect.arrayContaining(textTones.muted.split(" ")));
    expect(classes.filter((name) => textTones.subtle.split(" ").includes(name))).toEqual([]);
  });
});
