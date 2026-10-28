import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeSendIntentError } from "../sendIntentErrorMessage";

describe("describeSendIntentError", () => {
  it("tells a teammate to queue instead of steering someone else's browser or granted turn", () => {
    expect(describeSendIntentError("browser_turn_steer_forbidden", "forbidden")).toBe(
      "Only the person who started this turn can steer it. Queue your message instead.",
    );
  });

  it("keeps the existing steer refusals", () => {
    expect(describeSendIntentError("no_active_job", "x")).toMatch(/finished before the steer/);
    expect(describeSendIntentError("active_turn_input_unavailable", "x")).toMatch(
      /Queue the message instead/,
    );
  });

  it("falls back to the controller message for codes it does not know", () => {
    expect(describeSendIntentError("some_future_code", "Controller said no")).toBe(
      "Controller said no",
    );
    expect(describeSendIntentError(null, "Controller said no")).toBe("Controller said no");
  });

  // ChatPanel is wired to a dozen providers, so mounting it in jsdom is not
  // practical (see chatPanelRunTraceAutoRetry.test.ts). Read the source to
  // prove the send-intent failure path uses this mapping.
  it("is the mapping ChatPanel shows for refused send intents", () => {
    const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
    const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");
    expect(chatPanel).toContain(
      'showStatus(describeSendIntentError(error.code, error.message), "warning", 5500);',
    );
  });
});
