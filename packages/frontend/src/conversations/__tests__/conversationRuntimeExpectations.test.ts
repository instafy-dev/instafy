import { describe, expect, it } from "vitest";
import {
  withDefaultInteractiveWorkspaceExpectations,
  withRuntimeExpectations,
} from "../conversationRuntimeExpectations";

describe("conversation runtime expectations", () => {
  it("merges terminal expectations without implying file changes", () => {
    expect(withRuntimeExpectations(null, { commandExecution: true })).toEqual({
      runtimeExpectations: {
        commandExecution: true,
      },
    });
  });

  it("keeps existing runtime expectations when adding explicit expectations", () => {
    expect(
      withRuntimeExpectations(
        {
          runtimeExpectations: {
            commandExecution: true,
          },
        },
        {
          workspaceFileChanges: true,
        },
      ),
    ).toEqual({
      runtimeExpectations: {
        commandExecution: true,
        workspaceFileChanges: true,
      },
    });
  });

  it("preserves explicit read-only workspace expectations", () => {
    expect(
      withRuntimeExpectations(
        {
          source: "test",
          runtimeExpectations: {
            workspaceFileChanges: false,
          },
        },
        {
          commandExecution: true,
        },
      ),
    ).toEqual({
      source: "test",
      runtimeExpectations: {
        workspaceFileChanges: false,
        commandExecution: true,
      },
    });
  });

  it("only adds workspace file-change expectations when explicitly requested", () => {
    expect(
      withRuntimeExpectations(
        {
          source: "test",
        },
        {
          workspaceFileChanges: true,
        },
      ),
    ).toEqual({
      source: "test",
      runtimeExpectations: {
        workspaceFileChanges: true,
      },
    });
  });

  it("keeps existing runtime expectations when adding another expectation", () => {
    expect(
      withRuntimeExpectations(
        {
          runtimeExpectations: {
            commandExecution: true,
          },
        },
        {
          genericMcpToolExecution: true,
        },
      ),
    ).toEqual({
      runtimeExpectations: {
        commandExecution: true,
        genericMcpToolExecution: true,
      },
    });
  });

  it("defaults interactive Q&A to write-capable without requiring a file mutation", () => {
    expect(
      withDefaultInteractiveWorkspaceExpectations({
        source: "composer",
        runtimeExpectations: {
          commandExecution: false,
        },
      }),
    ).toEqual({
      source: "composer",
      writeIntent: true,
      runtimeExpectations: {
        commandExecution: false,
      },
    });
  });

  it("preserves an explicit workspace mutation requirement", () => {
    const metadata = {
      runtimeExpectations: {
        workspaceFileChanges: true,
      },
    };

    expect(withDefaultInteractiveWorkspaceExpectations(metadata)).toBe(metadata);
  });
});
