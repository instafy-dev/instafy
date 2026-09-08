// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SharedBrowserApprovalPrompt,
  sharedBrowserApprovalAllowDecision,
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
