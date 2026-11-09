// @vitest-environment jsdom
import { act, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineNotice } from "../InlineNotice";
import { Button, IconButton } from "../Button";

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

  it("keeps inline recovery feedback addressable without submitting its surrounding form", async () => {
    const retry = vi.fn();
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    await act(async () => root.render(
      <form onSubmit={submit}>
        <InlineNotice appearance="inline" tone="danger" role="alert" id="connection-error"
          actions={<Button preset="inline" aria-describedby="connection-error" onPress={retry}>Retry</Button>}>
          The connection ended. Your draft is still available.
        </InlineNotice>
      </form>,
    ));
    const notice = container.querySelector('#connection-error')!;
    const action = notice.querySelector<HTMLButtonElement>('button')!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("Your draft is still available.");
    expect(action.getAttribute("aria-describedby")).toBe(notice.id);
    await act(async () => action.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps attached feedback addressable and dismissal independent from recovery and form submission", async () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    await act(async () => root.render(
      <form onSubmit={submit}>
        <InlineNotice appearance="bar" tone="danger" role="alert" id="browser-feedback"
          actions={<Button preset="inline" onPress={retry}>Retry</Button>}
          dismiss={<IconButton aria-label="Dismiss message" onPress={dismiss}>×</IconButton>}>
          Unable to open this page. Your address draft is still available.
        </InlineNotice>
      </form>,
    ));
    const notice = container.querySelector('#browser-feedback')!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("Your address draft is still available.");
    await act(async () => notice.querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!.click());
    expect(dismiss).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
