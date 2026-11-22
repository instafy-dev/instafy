import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ControllerRuntimeClaudeCodeNotReadyReason } from "../../../services/runtimeController/runtimes";
import {
  CLAUDE_CODE_COPY,
  claudeCodeDesktopProblemSentence,
  claudeCodeLoginRefusalSentence,
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

describe("Claude Code wording outside a turn's own row", () => {
  it("never uses a word the product keeps out of these sentences", () => {
    for (const sentence of stringsIn(CLAUDE_CODE_COPY)) {
      // The design's own sentence before Delete (docs/Settings-UI.md, Your
      // AI) says agents "switch" to the first login: the verb, never the
      // controller's switch the rule keeps out.
      if (sentence === CLAUDE_CODE_COPY.yourAi.logins.deleteConfirm) {
        expect(bannedWordIn(sentence.replace(/\bswitch to\b/u, "go to")), sentence).toBeNull();
        continue;
      }
      expect(bannedWordIn(sentence), sentence).toBeNull();
    }
  });

  // docs/Local-Engine-Turns.md 11.19 and docs/Settings-UI.md (Your AI).
  it("keeps the design's words for the person's Claude Code logins", () => {
    const logins = CLAUDE_CODE_COPY.yourAi.logins;
    expect(logins.defaultLabel).toBe("Claude Code");
    expect(logins.ready).toBe("Ready.");
    expect(logins.notSignedIn).toBe(
      "Not signed in yet. In a terminal, run claude with CLAUDE_CONFIG_DIR set to this folder and sign in with /login.",
    );
    expect(logins.notSignedInUsualFolder).toBe("Not signed in yet. In a terminal, run claude and sign in with /login.");
    expect(`${logins.planLimitBefore} 6:00 PM.`).toBe("Reached its Claude plan's limit. Ready again at 6:00 PM.");
    expect(logins.usualFolder).toBe("Claude Code's usual folder");
    expect(logins.notSetUpHere).toBe("Not set up on this computer");
    expect(logins.setUp).toBe("Set up on this computer");
    expect(logins.add).toBe("Add a login");
    expect(logins.removeHere).toBe("Remove from this computer");
    expect(logins.deleteConfirm).toBe("Agents that use it switch to your first login.");
    expect(CLAUDE_CODE_COPY.agentAi.firstLogin).toBe("(first login)");
  });

  it("words the controller's refusals of a change to the logins by their codes, and nothing else raw", () => {
    const errors = CLAUDE_CODE_COPY.yourAi.logins.errors;
    expect(claudeCodeLoginRefusalSentence("claude_code_login_label_taken")).toBe(errors.labelTaken);
    expect(claudeCodeLoginRefusalSentence("claude_code_login_label_invalid")).toBe(errors.labelInvalid);
    expect(claudeCodeLoginRefusalSentence("claude_code_login_limit")).toBe(errors.limit);
    expect(claudeCodeLoginRefusalSentence("claude_code_turn_not_allowed")).toBe(errors.notAllowed);
    expect(claudeCodeLoginRefusalSentence(null)).toBe(errors.changeFailed);
    expect(claudeCodeLoginRefusalSentence("internal_error")).toBe(errors.changeFailed);
  });

  it("names Anthropic's current terms on both lines, and the plan only for a plan sign-in", () => {
    expect(claudeCodeSignInLine(true)).toBe("Runs on your own Claude plan, under Anthropic's current terms.");
    expect(claudeCodeSignInLine(false)).toBe(
      "Uses your own Claude Code sign-in, under Anthropic's current terms.",
    );
    expect(claudeCodeSignInLine(false)).not.toContain("plan");
  });

  // docs/Local-Engine-Turns.md 11.3: Claude Code as an agent's AI.
  it("keeps the design's agent editor words", () => {
    expect(CLAUDE_CODE_COPY.agentAi.label).toBe("Claude Code");
    expect(CLAUDE_CODE_COPY.agentAi.description).toBe(
      "Runs on your own Claude Code, on your computer. Its turns wait while your computer is off.",
    );
    // The pointer names the row of Your AI that sets it up.
    expect(CLAUDE_CODE_COPY.agentAi.setUpHere).toContain(CLAUDE_CODE_COPY.yourAi.title);
    expect(CLAUDE_CODE_COPY.agentAi.notAllowed).toBe("Claude Code turns aren't on for your account.");
  });

  // 11.14: what a waiting turn's row adds for its person.
  it("keeps the design's words for what makes a waiting turn run", () => {
    expect(CLAUDE_CODE_COPY.waiting.startHere).toBe("Start this space on this computer to run it.");
    expect(CLAUDE_CODE_COPY.waiting.elsewhere).toBe("It runs when Instafy Desktop runs this space on your computer.");
    expect(CLAUDE_CODE_COPY.waiting.startAction).toBe("Start");
  });

  // 11.14: Claude Code is an agent's AI now, never a choice for one message.
  it("never speaks of a message's own choice of Claude Code", () => {
    for (const sentence of stringsIn(CLAUDE_CODE_COPY)) {
      expect(sentence, sentence).not.toMatch(/next message|for my messages|your messages|composer/i);
    }
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
    expect(CLAUDE_CODE_COPY.yourAi.enable).toBe("Use Claude Code on this computer");
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
      "Find read new settings from your login shell that Instafy Desktop can use with this copy. Choose Use Claude Code on this computer to use them.",
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
