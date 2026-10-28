// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SharedBrowserApprovalPrompt,
  sharedBrowserApprovalAllowDecision,
  sharedBrowserApprovalTargetAddress,
  type SharedBrowserApprovalPromptRequest,
} from "../SharedBrowserApprovalPrompt";

const originRequest: SharedBrowserApprovalPromptRequest = {
  approvalId: "11111111-1111-4111-8111-111111111111",
  kind: "origin",
  operation: "approve-origin",
  sourceOrigin: null,
  destinationOrigin: "https://example.test",
  expiresAtMs: Date.now() + 30_000,
  display: {
    label: "Use example.test",
    destinationOrigin: "https://example.test",
  },
};

describe("SharedBrowserApprovalPrompt", () => {
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

  it("maps the only valid allow decision for each request kind", () => {
    expect(sharedBrowserApprovalAllowDecision("origin")).toBe("allow_origin");
    expect(sharedBrowserApprovalAllowDecision("action")).toBe("allow_once");
  });

  it("defaults focus to deny and submits an origin-scoped grant", async () => {
    const onDecision = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          error={null}
          onDecision={onDecision}
          request={originRequest}
          submitting={false}
        />,
      );
    });

    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Allow the AI agent to use this site?");
    expect(container.textContent).toContain("https://example.test");
    const deny = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-approval-deny"]',
    );
    expect(document.activeElement).toBe(deny);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')
        ?.click();
    });
    expect(onDecision).toHaveBeenCalledWith("allow_origin");
  });

  it("shows the exact page a site prompt opens, and says that pages on an allowed site open without asking", async () => {
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          onDecision={vi.fn()}
          request={{
            ...originRequest,
            display: { label: "Open https://example.test/en/places/belem-tower?lang=en", destinationOrigin: "https://example.test" },
          }}
          submitting={false}
        />,
      );
    });
    expect(container.querySelector('[data-testid="shared-browser-approval-destination"]')?.textContent)
      .toBe("example.test/en/places/belem-tower?lang=en");
    expect(container.textContent).toContain("Page");
    expect(container.textContent).toContain("its pages open without asking again. Other actions still ask.");
    expect(container.textContent).not.toContain("You will still approve actions separately.");
  });

  it("reads the page from the label only when it is on the prompt's own site", () => {
    const base = { kind: "origin" as const, operation: "approve-origin", destinationOrigin: "https://example.test" };
    const target = (label: string, extra: Partial<SharedBrowserApprovalPromptRequest> = {}) =>
      sharedBrowserApprovalTargetAddress({ ...base, ...extra, display: { label, destinationOrigin: "https://example.test" } });
    expect(target("Octo's tab 2: Open https://example.test/ in a new tab")).toBe("example.test");
    expect(target("Open https://example.test/long/path…")).toBe("example.test/long/path\u2026");
    expect(target("Open https://other.example/path")).toBeNull();
    expect(target("Allow the assistant to read and interact with this site for this run")).toBeNull();
    // A click's label is the control's name, which a page chooses.
    expect(target("https://example.test/fake", { kind: "action", operation: "click" })).toBeNull();
    expect(target("Go to https://example.test/files/a.pdf", { kind: "action", operation: "navigate" }))
      .toBe("example.test/files/a.pdf");
  });

  it("denies on Escape and explains one-shot action approval", async () => {
    const onDecision = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          onDecision={onDecision}
          request={{
            ...originRequest,
            approvalId: "22222222-2222-4222-8222-222222222222",
            kind: "action",
            operation: "click",
            display: { label: "Sign in", destinationOrigin: null },
          }}
          submitting={false}
        />,
      );
    });

    expect(container.textContent).toContain("The AI agent is waiting to click “Sign in”.");
    expect(container.textContent).toContain("This approval is used once.");
    await act(async () => {
      container
        .querySelector('[data-testid="shared-browser-approval-scrim"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDecision).toHaveBeenCalledWith("deny");
  });

  it("offers explicit routine approval at the first site prompt and scopes it to that request", async () => {
    const onDecision = vi.fn();
    const render = (request = originRequest) => root.render(
      <SharedBrowserApprovalPrompt routineApprovalAvailable onDecision={onDecision} request={request} submitting={false} />,
    );
    await act(async () => render());
    const checkbox = container.querySelector<HTMLInputElement>('[data-testid="shared-browser-approval-routine"]');
    expect(checkbox?.checked).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="shared-browser-approval-deny"]'));
    await act(async () => checkbox?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')?.click());
    expect(onDecision).toHaveBeenLastCalledWith("allow_routine");
    await act(async () => render({ ...originRequest, approvalId: "new-request" }));
    expect(container.querySelector<HTMLInputElement>('[data-testid="shared-browser-approval-routine"]')?.checked).toBe(false);
    await act(async () => render({ ...originRequest, kind: "action", operation: "click" }));
    expect(container.querySelector('[data-testid="shared-browser-approval-routine"]')).toBeNull();
  });

  it("never offers routine approval without runtime support", async () => {
    await act(async () => root.render(
      <SharedBrowserApprovalPrompt onDecision={vi.fn()} request={originRequest} submitting={false} />,
    ));
    expect(container.querySelector('[data-testid="shared-browser-approval-routine"]')).toBeNull();
  });

  it.each([
    ["type", "Search", "type into “Search”"],
    ["form-submit", "Email", "submit the form from “Email”"],
    ["press-enter", "Continue", "press Enter on “Continue”"],
    ["press-space", "Remember me", "press Space on “Remember me”"],
    ["press-key", "Press Backspace on Search", "press the requested key (Press Backspace on Search)"],
    // The runtime's category leads its label: only the name is quoted, and
    // the category says what it adds after it.
    ["click", "Change something: unnamed button in the top right", "click “unnamed button in the top right”"],
    ["click", "Delete, cancel or sign out: Delete account",
      "click “Delete account”. It may delete, cancel or sign out of something"],
  ])("states the %s operation even when the runtime supplies a label", async (operation, label, expected) => {
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          onDecision={vi.fn()}
          request={{
            ...originRequest,
            approvalId: "22222222-2222-4222-8222-222222222222",
            kind: "action",
            operation,
            display: { label, destinationOrigin: null },
          }}
          submitting={false}
        />,
      );
    });

    expect(container.textContent).toContain(`The AI agent is waiting to ${expected}.`);
  });

  it("keeps both decisions disabled while a decision is being written", async () => {
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          error="The request changed."
          onDecision={vi.fn()}
          request={originRequest}
          submitting
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The request changed.",
    );
  });

  it("refocuses Deny when a mounted hidden prompt becomes active", async () => {
    const onDecision = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          active={false}
          onDecision={onDecision}
          request={originRequest}
          submitting={false}
        />,
      );
    });
    const deny = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-approval-deny"]',
    );
    expect(document.activeElement).not.toBe(deny);

    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          active
          onDecision={onDecision}
          request={originRequest}
          submitting={false}
        />,
      );
    });
    expect(document.activeElement).toBe(deny);
  });
});
