import { describe, expect, it } from "vitest";
import {
  hostedRuntimeLimitDetailsFromError,
  parseHostedRuntimeLimitDetails,
  parseHostedRuntimeLimitError,
} from "../hostedRuntimeLimitError";

describe("parseHostedRuntimeLimitError", () => {
  it("returns limit details with blocker runtime/project ids when present", () => {
    const message =
      'Instafy Cloud runtime limit reached for this organization (2 active; max 2). Active runtime "Hosted Runtime" is attached to project "Other Project" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.';

    expect(parseHostedRuntimeLimitError(message)).toEqual({
      limitReached: true,
      activeCount: 2,
      maxActiveCount: 2,
      blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockerProjectLabel: "Other Project",
      blockerRuntimeLabel: "Hosted Runtime",
    });
  });

  it("flags limit errors without blocker ids", () => {
    const message =
      "Instafy Cloud runtime limit reached for this organization (2 active; max 2). Stop another runtime or upgrade your plan.";

    expect(parseHostedRuntimeLimitError(message)).toEqual({
      limitReached: true,
      activeCount: 2,
      maxActiveCount: 2,
      blockerProjectId: null,
      blockerRuntimeId: null,
      blockerProjectLabel: null,
      blockerRuntimeLabel: null,
    });
  });

  it("ignores unrelated errors", () => {
    const message = "Unable to ensure runtime (500): upstream unavailable";

    expect(parseHostedRuntimeLimitError(message)).toEqual({
      limitReached: false,
      activeCount: null,
      maxActiveCount: null,
      blockerProjectId: null,
      blockerRuntimeId: null,
      blockerProjectLabel: null,
      blockerRuntimeLabel: null,
    });
  });

  it("uses structured runtime limit details when provided", () => {
    const details = {
      activeCount: 2,
      maxActiveCount: 2,
      blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockerProjectLabel: "Other Project",
      blockerRuntimeLabel: "Hosted Runtime",
    };
    const parsed = parseHostedRuntimeLimitDetails(details);

    expect(parsed).toEqual({
      limitReached: true,
      activeCount: 2,
      maxActiveCount: 2,
      blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockerProjectLabel: "Other Project",
      blockerRuntimeLabel: "Hosted Runtime",
    });
    expect(parseHostedRuntimeLimitError("unrelated message", parsed)).toEqual({
      limitReached: true,
      activeCount: 2,
      maxActiveCount: 2,
      blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockerProjectLabel: "Other Project",
      blockerRuntimeLabel: "Hosted Runtime",
    });
  });

  it("extracts structured runtime limit details from controller errors", () => {
    const error = {
      code: "runtime_limit_reached",
      details: {
        activeCount: 2,
        maxActiveCount: 2,
        blockerProjectLabel: "Other Project",
      },
    };

    expect(hostedRuntimeLimitDetailsFromError(error)).toEqual({
      limitReached: true,
      activeCount: 2,
      maxActiveCount: 2,
      blockerProjectId: null,
      blockerRuntimeId: null,
      blockerProjectLabel: "Other Project",
      blockerRuntimeLabel: null,
    });
  });
});
