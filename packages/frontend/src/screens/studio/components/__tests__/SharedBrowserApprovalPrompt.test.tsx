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

    // The chat row's words: Octo asks, in one sentence, for the site.
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(container.querySelector("#shared-browser-approval-title")?.textContent).toBe("Octo wants to use example.test.");
    expect(container.querySelector('[data-testid="shared-browser-approval-allow"]')?.textContent).toBe("Allow site");
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

  it("names the exact page a site prompt opens, and nothing a first-time reader has to decode", async () => {
    // Drive, Oct 28: "Allow the AI agent to use this site? Shared Browser is
    // paused before the AI agent can read or act on a new site." with an
    // "Always allow routine browsing for this turn" box under it.
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
    expect(container.querySelector("#shared-browser-approval-title")?.textContent)
      .toBe("Octo wants to open example.test/en/places/belem-tower?lang=en.");
    // The sentence names the exact page, so no box repeats it.
    expect(container.querySelector('[data-testid="shared-browser-approval-destination"]')).toBeNull();
    expect(container.textContent).not.toContain("https://");
    for (const words of ["the AI agent", "Shared Browser", "routine browsing", "AI turn", "This approval is used once"]) {
      expect(container.textContent).not.toContain(words);
    }
    expect(container.querySelector('[data-testid="shared-browser-approval-routine"]')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
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

    expect(container.querySelector("#shared-browser-approval-title")?.textContent)
      .toBe("Octo wants to click “Sign in” on example.test.");
    expect(container.querySelector('[data-testid="shared-browser-approval-allow"]')?.textContent).toBe("Allow");
    await act(async () => {
      container
        .querySelector('[data-testid="shared-browser-approval-scrim"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDecision).toHaveBeenCalledWith("deny");
  });

  it("asks in the name of the agent that holds the browser", async () => {
    await act(async () => root.render(
      <SharedBrowserApprovalPrompt agentName="Ada" onDecision={vi.fn()} request={originRequest} submitting={false} />,
    ));
    expect(container.querySelector("#shared-browser-approval-title")?.textContent).toBe("Ada wants to use example.test.");
  });

  it("wraps keyboard focus inside the prompt", async () => {
    const onDecision = vi.fn();
    await act(async () => root.render(
      <SharedBrowserApprovalPrompt onDecision={onDecision} request={originRequest} submitting={false} />,
    ));
    const first = container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-deny"]')!;
    const last = container.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')!;
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      last.focus();
      last.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => first.dispatchEvent(shiftTab));
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it.each([
    ["type", "Search", "Octo wants to type into “Search” on example.test."],
    ["form-submit", "Email", "Octo wants to send the form “Email” on example.test."],
    ["press-enter", "Continue", "Octo wants to press Enter on “Continue” on example.test."],
    ["press-space", "Remember me", "Octo wants to press Space on “Remember me” on example.test."],
    ["press-key", "Press Backspace on Search", "Octo wants to press Backspace on Search on example.test."],
    // The runtime's category leads its label: only the name is quoted, and
    // the category says what it adds after it.
    ["click", "Change something: unnamed button in the top right", "Octo wants to click “unnamed button in the top right” on example.test."],
  ])("states the %s operation in the chat row's words", async (operation, label, expected) => {
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          onDecision={vi.fn()}
          request={{
            ...originRequest,
            approvalId: "22222222-2222-4222-8222-222222222222",
            kind: "action",
            operation,
            sourceOrigin: "https://example.test",
            display: { label, destinationOrigin: null },
          }}
          submitting={false}
        />,
      );
    });

    expect(container.querySelector("#shared-browser-approval-title")?.textContent).toBe(expected);
  });

  it("says what a step does in the page's words: the shown text first, the fields a form sends, and where it goes", async () => {
    // A form's submit asked as "Octo wants to click “Submit order” on
    // httpbin.org." over a "Destination https://httpbin.org" box, and a
    // banner's button as "Agree and close: Agree to our data proc…", which
    // cut the pair as one and lost the text the button shows.
    const action = (operation: string, label: string, destinationOrigin: string | null) => ({
      ...originRequest,
      approvalId: "33333333-3333-4333-8333-333333333333",
      kind: "action" as const,
      operation,
      sourceOrigin: "https://httpbin.org",
      destinationOrigin,
      display: { label, destinationOrigin },
    });
    const title = () => container.querySelector("#shared-browser-approval-title")?.textContent;
    const goesTo = () => container.querySelector('[data-testid="shared-browser-approval-destination"]')?.textContent ?? null;

    await act(async () => root.render(
      <SharedBrowserApprovalPrompt
        onDecision={vi.fn()}
        request={action(
          "click",
          "Change something: Submit order \u00b7 Sends: Customer name, Telephone, E-mail address, Pizza Size, Delivery instructions",
          "https://httpbin.org",
        )}
        submitting={false}
      />,
    ));
    expect(title()).toBe(
      "Octo wants to click “Submit order” on httpbin.org. Sends: Customer name, Telephone, E-mail address, Pizza Size, Delivery instructions.",
    );
    expect(goesTo()).toBe("Goes to httpbin.org");
    expect(container.textContent).not.toContain("https://");
    expect(container.textContent).not.toContain("Destination");

    await act(async () => root.render(
      <SharedBrowserApprovalPrompt
        onDecision={vi.fn()}
        request={action(
          "click",
          "Change something: Agree and close (also called \"Agree and close: Agree to our data processing and close\")",
          null,
        )}
        submitting={false}
      />,
    ));
    expect(title()).toBe(
      "Octo wants to click “Agree and close” (also called “Agree and close: Agree to our data proc…”) on httpbin.org.",
    );
    expect(goesTo()).toBeNull();

    // An older runtime led with the other name: the shown text still leads.
    await act(async () => root.render(
      <SharedBrowserApprovalPrompt
        onDecision={vi.fn()}
        request={action("click", "Learn More: Configure your consents (shown as \"Learn More \u2192\")", null)}
        submitting={false}
      />,
    ));
    expect(title()).toBe("Octo wants to click “Learn More →” (also called “Learn More: Configure your consents”) on httpbin.org.");

    // A form sent to another site already says where it goes.
    await act(async () => root.render(
      <SharedBrowserApprovalPrompt
        onDecision={vi.fn()}
        request={action("form-submit", "Search \u00b7 Sends: Search", "https://search.example.org")}
        submitting={false}
      />,
    ));
    expect(title()).toBe("Octo wants to send the form “Search” on httpbin.org. It goes to search.example.org. Sends: Search.");
    expect(goesTo()).toBeNull();
  });

  it("keeps both decisions disabled while a decision is being written", async () => {
    const onDecision = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserApprovalPrompt
          error="The request changed."
          onDecision={onDecision}
          request={originRequest}
          submitting
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => {
      buttons.forEach((button) => button.click());
      container.querySelector('[data-testid="shared-browser-approval-scrim"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDecision).not.toHaveBeenCalled();
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
