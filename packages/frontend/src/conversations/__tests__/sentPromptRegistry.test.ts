import { beforeEach, describe, expect, it } from "vitest";
import {
  claimAutoRetryForPromptSentFromThisPage,
  didSendFailForPromptSentFromThisPage,
  forgetPromptsSentFromThisPageForTests,
  readRetrySentFromThisPage,
  recordRunsStartedByPromptSentFromThisPage,
  recordSendFailedForPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
  wasRunStartedByPromptSentFromThisPage,
} from "../sentPromptRegistry";

// The optimistic copy the submit path appends, and the copy the controller
// stores: a new id, the client message id kept under prompt_metadata.
const LOCAL_COPY = {
  id: "user-1727784000000-abc",
  metadata: { clientMessageId: "client-1", client: { sessionId: "session-1" } },
};
const STORED_COPY = {
  id: "5f0c2b8e-0000-4000-8000-000000000001",
  metadata: { prompt_metadata: { clientMessageId: "client-1" }, runId: "run-1" },
};
// What the submit path dispatches: the prompt's metadata, without its id.
const DISPATCHED = { metadata: { clientMessageId: "client-1" } };

describe("sentPromptRegistry", () => {
  beforeEach(() => {
    forgetPromptsSentFromThisPageForTests();
  });

  it("knows the runs a prompt this page sent started, by either copy", () => {
    rememberPromptSentFromThisPage(LOCAL_COPY);
    expect(wasRunStartedByPromptSentFromThisPage(LOCAL_COPY, ["run-1"])).toBe(false);

    recordRunsStartedByPromptSentFromThisPage(DISPATCHED, ["run-1", "job-1"]);
    expect(wasRunStartedByPromptSentFromThisPage(LOCAL_COPY, ["job-1"])).toBe(true);
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, ["run-1"])).toBe(true);
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, ["run-2"])).toBe(false);
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, [])).toBe(false);
    expect(
      wasRunStartedByPromptSentFromThisPage(
        { id: "other", metadata: { prompt_metadata: { clientMessageId: "client-2" } } },
        ["run-1"],
      ),
    ).toBe(false);
  });

  it("never matches a prompt that started no run, such as a note that was only recorded", () => {
    rememberPromptSentFromThisPage(LOCAL_COPY);
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, ["run-1"])).toBe(false);
  });

  it("ignores runs for a prompt this page did not send", () => {
    recordRunsStartedByPromptSentFromThisPage(DISPATCHED, ["run-1"]);
    rememberPromptSentFromThisPage({ id: "user-2", metadata: { clientMessageId: "client-2" } });
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, ["run-1"])).toBe(false);
  });

  it("forgets everything on reload", () => {
    rememberPromptSentFromThisPage(LOCAL_COPY);
    recordRunsStartedByPromptSentFromThisPage(DISPATCHED, ["run-1"]);
    forgetPromptsSentFromThisPageForTests();
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, ["run-1"])).toBe(false);
    expect(claimAutoRetryForPromptSentFromThisPage(STORED_COPY)).toBe(false);
  });

  it("gives out a prompt's automatic retry once, whichever copy asks", () => {
    expect(claimAutoRetryForPromptSentFromThisPage(LOCAL_COPY)).toBe(false);
    rememberPromptSentFromThisPage(LOCAL_COPY);
    expect(claimAutoRetryForPromptSentFromThisPage(STORED_COPY)).toBe(true);
    expect(claimAutoRetryForPromptSentFromThisPage(LOCAL_COPY)).toBe(false);
    // Recording the prompt again does not hand the retry out again.
    rememberPromptSentFromThisPage(LOCAL_COPY);
    expect(claimAutoRetryForPromptSentFromThisPage(STORED_COPY)).toBe(false);
  });

  it("tells what became of a retry of a failure", () => {
    const retry = {
      id: "user-retry",
      metadata: { clientMessageId: "client-retry", retryOfMessageId: "failure-1" },
    };
    expect(readRetrySentFromThisPage("failure-1")).toBeNull();
    rememberPromptSentFromThisPage(retry);
    // Sent, but only recorded: no run.
    expect(readRetrySentFromThisPage("failure-1")).toBe("sent");
    recordRunsStartedByPromptSentFromThisPage({ metadata: retry.metadata }, ["run-retry"]);
    expect(readRetrySentFromThisPage("failure-1")).toBe("started_run");
    expect(readRetrySentFromThisPage("failure-2")).toBeNull();
  });

  it("knows a prompt whose send failed, by either copy", () => {
    const retry = {
      id: "user-retry",
      metadata: { clientMessageId: "client-retry", retryOfMessageId: "failure-1" },
    };
    const storedRetry = {
      id: "stored-retry",
      metadata: { prompt_metadata: { clientMessageId: "client-retry", retryOfMessageId: "failure-1" } },
    };
    rememberPromptSentFromThisPage(retry);
    expect(didSendFailForPromptSentFromThisPage(retry)).toBe(false);

    // The dispatch failed: the controller did not take the resend.
    recordSendFailedForPromptSentFromThisPage({ metadata: retry.metadata });
    expect(didSendFailForPromptSentFromThisPage(retry)).toBe(true);
    expect(didSendFailForPromptSentFromThisPage(storedRetry)).toBe(true);
    expect(readRetrySentFromThisPage("failure-1")).toBe("failed");

    // Another try of the same failure that went out wins.
    const again = {
      id: "user-retry-2",
      metadata: { clientMessageId: "client-retry-2", retryOfMessageId: "failure-1" },
    };
    rememberPromptSentFromThisPage(again);
    expect(readRetrySentFromThisPage("failure-1")).toBe("sent");
    expect(didSendFailForPromptSentFromThisPage(again)).toBe(false);
  });

  it("does not count a prompt as failed when another of its dispatches started a run", () => {
    // A prompt sent to two agent threads: one dispatch failed, one started a run.
    rememberPromptSentFromThisPage(LOCAL_COPY);
    recordSendFailedForPromptSentFromThisPage(DISPATCHED);
    recordRunsStartedByPromptSentFromThisPage(DISPATCHED, ["run-1"]);
    expect(didSendFailForPromptSentFromThisPage(STORED_COPY)).toBe(false);
  });

  it("ignores a failed send of a prompt this page did not send", () => {
    recordSendFailedForPromptSentFromThisPage(DISPATCHED);
    expect(didSendFailForPromptSentFromThisPage(STORED_COPY)).toBe(false);
  });

  it("keeps a bounded number of prompts, dropping the oldest", () => {
    rememberPromptSentFromThisPage(LOCAL_COPY);
    recordRunsStartedByPromptSentFromThisPage(DISPATCHED, ["run-1"]);
    for (let index = 0; index < 400; index += 1) {
      rememberPromptSentFromThisPage({ id: `user-${index}`, metadata: { clientMessageId: `c-${index}` } });
    }
    recordRunsStartedByPromptSentFromThisPage({ id: "user-399" }, ["run-399"]);
    expect(wasRunStartedByPromptSentFromThisPage(STORED_COPY, ["run-1"])).toBe(false);
    expect(wasRunStartedByPromptSentFromThisPage({ id: "user-399", metadata: null }, ["run-399"])).toBe(
      true,
    );
  });
});
