// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { BrowserSessionArrival } from "../BrowserSessionRecovery";
import { browserArrivalNote, browserTurnArrival } from "../browserTurnArrival";

function card(task: string, jobId: string): ChatMessage {
  return {
    id: `card-${jobId}`,
    role: "assistant",
    content: "Continue this task in Instafy's browser.",
    timestamp: 2,
    metadata: { jobId, messageType: "action_request", details: { browserRequest: { task, location: "auto" } } },
  };
}

function run(status: RunRecord["status"], metadata: Record<string, unknown>): RunRecord {
  return {
    id: `run-${status}`,
    projectId: "project",
    sessionId: null,
    conversationId: "chat",
    promptId: null,
    runType: "prompt",
    status,
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata,
    createdAt: null,
    updatedAt: null,
  };
}

const BLANK = { url: "about:blank" };
const PAGE = { url: "https://www.visitlisboa.com/en/places" };

describe("a chat's browser turn on its way to a blank tab", () => {
  const messages = [
    card("Open https://www.visitlisboa.com/ and find the Belém Tower opening hours.", "card-job"),
    card("Find authoritative pages for a first visit.", "plain-job"),
  ];

  // A local test: the browser stage showed a blank page for 17 s after a
  // press, until Octo's first page, with nothing said over it.
  it("says where Octo is going, from the card it continues", () => {
    const arrival = browserTurnArrival(
      [run("in_progress", { browserTransport: "shared", browserRequestOf: "job:card-job" })],
      messages,
    );
    expect(arrival).toEqual({ site: "visitlisboa.com" });
    expect(browserArrivalNote(arrival, BLANK, "Octo")).toBe("Octo is opening visitlisboa.com…");
  });

  it("says Octo is starting when the card named no site, or there is no card", () => {
    const plain = browserTurnArrival(
      [run("queued", { browserTransport: "shared", browserRequestOf: "job:plain-job" })],
      messages,
    );
    expect(browserArrivalNote(plain, BLANK, "Octo")).toBe("Octo is starting…");
    const typed = browserTurnArrival([run("in_progress", { browserTransport: "shared" })], messages);
    expect(browserArrivalNote(typed, { url: "" }, "Octo")).toBe("Octo is starting…");
  });

  it("says nothing over a page, or with no browser turn of the chat on its way", () => {
    const arrival = browserTurnArrival(
      [run("in_progress", { browserTransport: "shared", browserRequestOf: "job:card-job" })],
      messages,
    );
    expect(browserArrivalNote(arrival, PAGE, "Octo")).toBeNull();
    expect(browserTurnArrival([run("success", { browserTransport: "shared" })], messages)).toBeNull();
    expect(browserTurnArrival([run("in_progress", {})], messages)).toBeNull();
    expect(browserArrivalNote(null, BLANK, "Octo")).toBeNull();
  });

  it("is a plain status over the stage, never a control", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<BrowserSessionArrival note="Octo is opening visitlisboa.com…" />));
    const note = container.querySelector('[data-testid="browser-session-agent-arrival"]');
    expect(note?.textContent).toBe("Octo is opening visitlisboa.com…");
    expect(note?.querySelector('[role="status"]')).not.toBeNull();
    expect(note?.className).toContain("pointer-events-none");
    await act(async () => root.unmount());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
