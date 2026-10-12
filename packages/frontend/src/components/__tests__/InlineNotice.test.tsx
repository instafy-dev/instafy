// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineNotice } from "../InlineNotice";
import { Button } from "../Button";

describe("InlineNotice", () => {
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

  it("keeps rich recovery content valid and its actions independently operable", async () => {
    const retry = vi.fn();
    await act(async () => root.render(
      <InlineNotice tone="danger" title="Unable to read files" role="alert" density="comfortable"
        actions={<Button variant="outline" onPress={retry}>Retry</Button>}>
        <ul><li>Your loaded files are still available.</li><li>Retry to refresh this folder.</li></ul>
      </InlineNotice>,
    ));
    const notice = container.querySelector('[role="alert"]')!;
    expect(notice.textContent).toContain("Unable to read files");
    expect(notice.querySelectorAll("li")).toHaveLength(2);
    expect(notice.querySelector("p ul, p button")).toBeNull();
    expect(notice.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => notice.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("leaves announcement ownership explicit and supports status outcomes", async () => {
    await act(async () => root.render(<InlineNotice>Information only.</InlineNotice>));
    expect(container.querySelector("[role]")).toBeNull();
    await act(async () => root.render(<InlineNotice tone="success" role="status">Saved.</InlineNotice>));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved.");
    expect(container.querySelector("button")).toBeNull();
  });
});
