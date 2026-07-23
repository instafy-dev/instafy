import { describe, expect, it } from "vitest";

import { browserSessionWsDebugFields } from "../browserSessionDebug";

describe("browserSessionWsDebugFields", () => {
  it("omits credential-bearing websocket query parameters", () => {
    const fields = browserSessionWsDebugFields(
      "wss://runtime.example.test/browser/vnc?token=top-secret&authorization=also-secret",
    );

    expect(fields).toEqual({
      wsUrlHost: "runtime.example.test",
      wsUrlPath: "/browser/vnc",
    });
    expect(JSON.stringify(fields)).not.toContain("top-secret");
    expect(JSON.stringify(fields)).not.toContain("also-secret");
  });

  it("returns safe placeholders for malformed websocket addresses", () => {
    expect(browserSessionWsDebugFields("not a websocket address")).toEqual({
      wsUrlHost: "invalid",
      wsUrlPath: "invalid",
    });
  });
});
