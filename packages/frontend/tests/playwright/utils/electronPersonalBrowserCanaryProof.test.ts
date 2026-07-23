import { describe, expect, it } from "vitest";

import { parsePersonalBrowserToolEventProof } from "./electronPersonalBrowserCanaryProof.js";

describe("parsePersonalBrowserToolEventProof", () => {
  it("reads controller-wrapped MCP details for only the exact job", () => {
    const proof = parsePersonalBrowserToolEventProof(
      [
        {
          metadata: {
            jobId: "job-under-test",
            messageType: "mcp_tool_call",
            // These decoys must not hide a failed nested event.
            server: "instafy_personal_browser",
            status: "completed",
            details: {
              server: "instafy_personal_browser",
              status: "failed",
              tool: "type",
            },
          },
        },
        {
          metadata: {
            jobId: "job-under-test",
            messageType: "mcp_tool_call",
            details: {
              server: "instafy_personal_browser",
              status: "completed",
              tool: "snapshot",
            },
          },
        },
        {
          metadata: {
            jobId: "another-job",
            messageType: "command_execution",
            details: {},
          },
        },
      ],
      "job-under-test",
    );

    expect(proof).toEqual({
      hasCommandExecution: false,
      hasCompletedPersonalBrowserMcp: true,
      hasFailedPersonalBrowserMcp: true,
      hasRuntimeUnavailableAlert: false,
    });
  });

  it("detects runtime-unavailable alerts and rejects non-array responses", () => {
    expect(parsePersonalBrowserToolEventProof({}, "job-under-test")).toBeNull();
    expect(
      parsePersonalBrowserToolEventProof(
        [
          {
            metadata: {
              kind: "runtime_alert",
              details: { reason: "runtime_unavailable" },
            },
          },
        ],
        "job-under-test",
      ),
    ).toMatchObject({ hasRuntimeUnavailableAlert: true });
  });
});
