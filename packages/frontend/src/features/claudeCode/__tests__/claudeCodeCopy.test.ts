import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ControllerRuntimeClaudeCodeNotReadyReason } from "../../../services/runtimeController/runtimes";
import {
  CLAUDE_CODE_COPY,
  claudeCodeDesktopProblemSentence,
  claudeCodeNotReadySentence,
  claudeCodeSignInLine,
} from "../claudeCodeCopy";
import { parseClaudeCodeDesktopStatus, type ClaudeCodeDesktopProblem } from "../claudeCodeDesktop";
import { bannedWordIn, stringsIn } from "./claudeCodeBannedWords";

// The reasons a runtime attests are runtime-contracts' list: the same file the
// runtime's and the controller's tests read.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../..");
const { notReadyReasons } = JSON.parse(
  readFileSync(resolve(repo, "packages/runtime-contracts/src/claude_code_lane_fixtures.json"), "utf8"),
) as { notReadyReasons: ControllerRuntimeClaudeCodeNotReadyReason[] };

describe("Claude Code composer wording", () => {
  it("never uses a word the product keeps out of these sentences", () => {
    for (const sentence of stringsIn(CLAUDE_CODE_COPY)) {
      expect(bannedWordIn(sentence), sentence).toBeNull();
    }
  });

  it("names Anthropic's current terms on both lines, and the plan only for a plan sign-in", () => {
    expect(claudeCodeSignInLine(true)).toBe("Runs on your own Claude plan, under Anthropic's current terms.");
    expect(claudeCodeSignInLine(false)).toBe(
      "Uses your own Claude Code sign-in, under Anthropic's current terms.",
    );
    expect(claudeCodeSignInLine(false)).not.toContain("plan");
  });

  it("keeps the design's row and token words", () => {
    expect(CLAUDE_CODE_COPY.rowTitle).toBe("Claude Code for the next message");
    expect(CLAUDE_CODE_COPY.rowHint).toBe(
      "Instafy gives Claude Code only your message. Everyone who can see this chat sees its steps and reply.",
    );
    expect(CLAUDE_CODE_COPY.tokenLabel).toBe("Claude Code · next message");
    expect(CLAUDE_CODE_COPY.tokenCancel).toBe("Don't use Claude Code");
  });

  it("has a sentence for every reason a runtime attests, and only for those", () => {
    expect(notReadyReasons.length).toBeGreaterThan(0);
    expect(Object.keys(CLAUDE_CODE_COPY.notReady).sort()).toEqual([...notReadyReasons].sort());
    expect(Object.keys(CLAUDE_CODE_COPY.yourAi.notReady).sort()).toEqual([...notReadyReasons].sort());
    for (const reason of notReadyReasons) {
      expect(claudeCodeNotReadySentence(reason)).toBe(CLAUDE_CODE_COPY.notReady[reason]);
    }
    expect(claudeCodeNotReadySentence(null)).toBe(CLAUDE_CODE_COPY.notReadyYet);
  });

  it("keeps the design's Your AI words", () => {
    expect(CLAUDE_CODE_COPY.yourAi.title).toBe("Claude Code on this computer");
    expect(CLAUDE_CODE_COPY.yourAi.enable).toBe("Use for my messages");
    expect(CLAUDE_CODE_COPY.yourAi.firstUse).toBe(
      "Sign in to Claude Code on this computer first: run claude in a terminal once.",
    );
  });

  // D26: the runtime refuses a copy others can change and a login-shell
  // CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS it can't use with one reason,
  // binary_unsafe, so no sentence blames the copy alone.
  it("names both causes where the runtime can't tell them apart", () => {
    for (const sentence of [CLAUDE_CODE_COPY.notReady.binary_unsafe, CLAUDE_CODE_COPY.yourAi.notReady.binary_unsafe]) {
      expect(sentence).toMatch(/other accounts on this computer can change/i);
      expect(sentence).toContain("CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS");
    }
  });

  // 4.1, D26: Find can read new login-shell settings for the copy in use when
  // the recorded ones no longer work; the button the sentence names confirms them.
  it("names the button that confirms new login-shell settings for the copy in use", () => {
    expect(CLAUDE_CODE_COPY.yourAi.candidateRenewed).toBe(
      "Find read new settings from your login shell that Instafy Desktop can use with this copy. Choose Use for my messages to use them.",
    );
    expect(CLAUDE_CODE_COPY.yourAi.candidateRenewed).toContain(`Choose ${CLAUDE_CODE_COPY.yourAi.enable}`);
    expect(bannedWordIn(CLAUDE_CODE_COPY.yourAi.candidateRenewed)).toBeNull();
  });

  it("names the login-shell setting Desktop can't use, when Desktop names it", () => {
    expect(claudeCodeDesktopProblemSentence("shell_setting_unusable", "CLAUDE_CONFIG_DIR")).toBe(
      "Your login shell sets CLAUDE_CONFIG_DIR to something Instafy Desktop can't use. It must be the full path of a folder that only you can change. Fix it, then choose Find.",
    );
    expect(claudeCodeDesktopProblemSentence("shell_setting_unusable", "NODE_EXTRA_CA_CERTS")).toBe(
      "Your login shell sets NODE_EXTRA_CA_CERTS to something Instafy Desktop can't use. It must be the full path of a file that only you can change. Fix it, then choose Find.",
    );
    expect(claudeCodeDesktopProblemSentence("shell_setting_unusable", null)).toBe(
      CLAUDE_CODE_COPY.yourAi.problems.shell_setting_unusable,
    );
    // A setting's name belongs to that problem alone.
    expect(claudeCodeDesktopProblemSentence("writable_by_others", "CLAUDE_CONFIG_DIR")).toBe(
      CLAUDE_CODE_COPY.yourAi.problems.writable_by_others,
    );
  });

  // Desktop's module (packages/desktop-app/src/claudeCode) answers with these
  // codes and names: Studio reads and words every one of them, and nothing else.
  it("reads and words every problem and login-shell setting Desktop's module answers with", () => {
    const desktopDir = resolve(repo, "packages/desktop-app/src/claudeCode");
    const validate = readFileSync(resolve(desktopDir, "validate.ts"), "utf8");
    const desktopModule = readFileSync(resolve(desktopDir, "index.ts"), "utf8");
    const literals = (source: string) => [...source.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
    const binaryProblems = literals(/export type ClaudeCodeBinaryProblem =([^;]+);/.exec(validate)?.[1] ?? "");
    const moduleProblems = literals(/export type ClaudeCodeDesktopProblem =([^;]+);/.exec(desktopModule)?.[1] ?? "");
    const shellSettings = [
      ...(/CLAUDE_CODE_SHELL_SETTING_KINDS = Object\.freeze\(\{([^}]+)\}/.exec(validate)?.[1] ?? "").matchAll(
        /([A-Z][A-Z_]+):/g,
      ),
    ].map((match) => match[1] ?? "");
    expect(binaryProblems.length).toBeGreaterThan(0);
    expect(moduleProblems.length).toBeGreaterThan(0);
    expect(shellSettings.length).toBeGreaterThan(0);

    const problems = [...binaryProblems, ...moduleProblems].sort();
    expect(Object.keys(CLAUDE_CODE_COPY.yourAi.problems).sort()).toEqual(problems);
    for (const problem of problems) {
      expect(
        parseClaudeCodeDesktopStatus({ supported: true, found: false, consented: true, problem, candidateProblem: problem }),
        problem,
      ).toMatchObject({ problem, candidateProblem: problem });
      expect(bannedWordIn(claudeCodeDesktopProblemSentence(problem as ClaudeCodeDesktopProblem, null)), problem).toBeNull();
    }
    expect(Object.keys(CLAUDE_CODE_COPY.yourAi.shellSettings).sort()).toEqual([...shellSettings].sort());
    for (const shellSetting of shellSettings) {
      expect(
        parseClaudeCodeDesktopStatus({ supported: true, found: true, consented: false, shellSetting }),
        shellSetting,
      ).toMatchObject({ shellSetting });
    }
  });
});
