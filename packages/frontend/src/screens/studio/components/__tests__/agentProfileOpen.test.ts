// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  OPEN_AGENT_PROFILE_EVENT,
  requestAgentProfile,
} from "../agentProfileOpen";

describe("requestAgentProfile", () => {
  it("dispatches normalized handles and drops empty ones", () => {
    const seen: string[] = [];
    const handler = (event: Event) => {
      seen.push((event as CustomEvent<{ handle: string }>).detail.handle);
    };
    window.addEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
    try {
      requestAgentProfile("@Octo ");
      requestAgentProfile("   ");
      requestAgentProfile("@");
      requestAgentProfile("scout");
    } finally {
      window.removeEventListener(OPEN_AGENT_PROFILE_EVENT, handler);
    }
    expect(seen).toEqual(["octo", "scout"]);
  });
});
