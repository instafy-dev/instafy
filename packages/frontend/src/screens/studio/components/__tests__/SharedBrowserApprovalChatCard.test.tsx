// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSharedBrowserApprovalRequest } from "../../../../sdk/instafy";
import {
  SHARED_BROWSER_APPROVAL_CHAT_COPY,
  SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS,
  SharedBrowserApprovalChatCard,
} from "../SharedBrowserApprovalChatCard";
import type { SharedBrowserApprovalState } from "../useSharedBrowserApproval";

const NOW = Date.UTC(2026, 9, 24, 7, 57, 14);

function request(overrides: Partial<RuntimeSharedBrowserApprovalRequest> = {}): RuntimeSharedBrowserApprovalRequest {
  return {
    version: 1, approvalId: "22222222-2222-4222-8222-222222222222", kind: "action",
    ownerId: "33333333-3333-4333-8333-333333333333", runId: "44444444-4444-4444-8444-444444444444",
    initiatorUserId: "55555555-5555-4555-8555-555555555555", browserPageId: "page-of-the-job",
    operation: "click", sourceOrigin: "https://app.freefinance.at", destinationOrigin: "https://app.freefinance.at",
    destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
    requestedAtMs: NOW, expiresAtMs: NOW + 120_000, requestFingerprint: "e".repeat(64),
    display: { label: "Menü ein-/ausklappen", destinationOrigin: null },
    ...overrides,
  };
}

function approval(overrides: Partial<SharedBrowserApprovalState> = {}): SharedBrowserApprovalState {
  return {
    pending: null, submitting: false, error: null, routineApprovedRunId: null, lastDecision: null,
    decide: vi.fn(async () => {}), ...overrides,
  };
}

const withPending = (value: RuntimeSharedBrowserApprovalRequest, overrides: Partial<SharedBrowserApprovalState> = {}) =>
  approval({ pending: { runtimeId: "11111111-1111-4111-8111-111111111111", request: value }, ...overrides });

describe("SharedBrowserApprovalChatCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(state: SharedBrowserApprovalState) {
    await act(async () => {
      root.render(<SharedBrowserApprovalChatCard agentDisplayName="Octo" approval={state} avatar={<span>O</span>} />);
    });
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const text = () => container.textContent ?? "";

  it("asks in the chat with the step, the site and how long is left", async () => {
    await render(withPending(request()));
    expect(text()).toContain("Instafy's browser");
    expect(text()).toContain("Allow this browser action?");
    expect(text()).toContain("Octo is waiting to click “Menü ein-/ausklappen” on app.freefinance.at.");
    expect(byTestId("chat-browser-approval-countdown")?.textContent).toBe("Only you can answer. Expires in 2:00.");
    expect(byTestId("chat-browser-approval-countdown")?.getAttribute("role")).toBe("timer");
    await advance(1_000);
    expect(byTestId("chat-browser-approval-countdown")?.textContent).toBe("Only you can answer. Expires in 1:59.");
    // It never takes focus from the composer.
    expect(document.activeElement).toBe(document.body);
    expect(text()).not.toMatch(/—/);
  });

  it("answers with the same decisions as the sheet", async () => {
    const actionState = withPending(request());
    await render(actionState);
    await act(async () => { byTestId("chat-browser-approval-allow")!.click(); });
    expect(actionState.decide).toHaveBeenCalledWith("allow_once");
    await act(async () => { byTestId("chat-browser-approval-deny")!.click(); });
    expect(actionState.decide).toHaveBeenCalledWith("deny");

    const originState = withPending(request({
      approvalId: "77777777-7777-4777-8777-777777777777", kind: "origin", operation: "approve-origin",
      sourceOrigin: null, destinationOrigin: "https://example.test",
    }));
    await render(originState);
    expect(text()).toContain("Allow Octo to use this site?");
    expect(text()).toContain("Octo paused before reading or acting on example.test.");
    expect(byTestId("chat-browser-approval-allow")?.textContent).toBe(SHARED_BROWSER_APPROVAL_CHAT_COPY.allowSite);
    await act(async () => { byTestId("chat-browser-approval-allow")!.click(); });
    expect(originState.decide).toHaveBeenCalledWith("allow_origin");
  });

  it("holds its buttons while an answer is saved, and shows what went wrong", async () => {
    await render(withPending(request(), { submitting: true, error: "Could not save the approval. Check your connection and try again." }));
    expect(byTestId("chat-browser-approval-allow")?.hasAttribute("disabled") ||
      byTestId("chat-browser-approval-allow")?.getAttribute("aria-disabled") === "true").toBe(true);
    expect(byTestId("chat-browser-approval-deny")?.hasAttribute("disabled") ||
      byTestId("chat-browser-approval-deny")?.getAttribute("aria-disabled") === "true").toBe(true);
    expect(byTestId("chat-browser-approval-error")?.getAttribute("role")).toBe("alert");
  });

  it.each([
    ["allow_once", "Allowed", "Octo is continuing."],
    ["deny", "Denied", "Octo won't take this step."],
  ] as const)("says what was decided (%s), whichever surface answered", async (decision, badge, note) => {
    const value = request();
    await render(withPending(value));
    await render(approval({ lastDecision: { approvalId: value.approvalId, decision } }));
    expect(byTestId("chat-browser-approval-state")?.textContent).toBe(`${badge}${note}`);
    expect(byTestId("chat-browser-approval-allow")).toBeNull();
    await advance(SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS * 2);
    expect(byTestId("chat-browser-approval-state")).not.toBeNull();
  });

  it("says a prompt nobody answered expired, without buttons", async () => {
    await render(withPending(request()));
    await advance(120_000);
    expect(byTestId("chat-browser-approval-state")?.textContent)
      .toBe(`${SHARED_BROWSER_APPROVAL_CHAT_COPY.expired}Octo didn't take this step. Send a message to continue.`);
    expect(byTestId("chat-browser-approval-allow")).toBeNull();
    expect(byTestId("chat-browser-approval-deny")).toBeNull();
    // The hook drops it once it expired; the card keeps saying so.
    await render(approval());
    await advance(SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS * 2);
    expect(byTestId("chat-browser-approval-state")?.textContent).toContain(SHARED_BROWSER_APPROVAL_CHAT_COPY.expired);
  });

  it("goes away when a prompt ends elsewhere, but not over a gap between polls", async () => {
    const value = request();
    await render(withPending(value));
    await render(approval());
    await advance(SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS - 500);
    await render(withPending({ ...value }));
    await advance(SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS);
    expect(byTestId("chat-browser-approval-card")).not.toBeNull();
    expect(byTestId("chat-browser-approval-allow")).not.toBeNull();
    await render(approval());
    await advance(SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS);
    expect(byTestId("chat-browser-approval-card")).toBeNull();
  });

  it("asks again for a new prompt after an answer", async () => {
    const first = request();
    await render(withPending(first));
    await render(approval({ lastDecision: { approvalId: first.approvalId, decision: "allow_once" } }));
    expect(text()).toContain("Allowed");
    await render(withPending(request({ approvalId: "88888888-8888-4888-8888-888888888888", operation: "navigate",
      destinationOrigin: "https://example.test", display: { label: "", destinationOrigin: "https://example.test" } })));
    expect(text()).toContain("Octo is waiting to open example.test.");
    expect(byTestId("chat-browser-approval-allow")).not.toBeNull();
  });

  it("shows nothing without a prompt", async () => {
    await render(approval());
    expect(container.innerHTML).toBe("");
  });
});
