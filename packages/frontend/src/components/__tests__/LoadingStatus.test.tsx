// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { LoadingStatus } from "../LoadingStatus";

it("announces pending content once and leaves surrounding controls mounted", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (loading: boolean) => (
    <section>
      <button>Other tab</button>
      {loading ? <LoadingStatus>Loading file…</LoadingStatus> : <p>File content</p>}
    </section>
  );
  try {
    await act(async () => root.render(render(true)));
    const status = container.querySelector('[role="status"]');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(status?.textContent).toBe("Loading file…");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(status?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    const button = container.querySelector("button");
    button?.focus();
    await act(async () => root.render(render(false)));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("File content");
    expect(document.activeElement).toBe(button);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
