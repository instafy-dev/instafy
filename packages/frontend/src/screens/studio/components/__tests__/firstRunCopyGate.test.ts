import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The em-dash gate for the first-run surfaces (the getting-started card, the
// credential gate bubble, the composer's Connect rows and the copy they draw
// on): no U+2014 anywhere in these files, comments included, and no "please"
// in their user-facing strings. Extend the list with every file the first-run
// journey touches.

const here = dirname(fileURLToPath(import.meta.url));
const components = resolve(here, "..");
const frontend = resolve(components, "../../../..");
const repo = resolve(frontend, "../..");

const GATED_FILES = [
  resolve(components, "AiCredentialsStatusBubble.tsx"),
  resolve(components, "ChatGettingStartedCard.tsx"),
  resolve(components, "ChatPanel.tsx"),
  resolve(components, "ChatSystemRows.tsx"),
  resolve(components, "ComposerActionMenu.tsx"),
  resolve(components, "ConnectChipStrip.tsx"),
  resolve(components, "connectors.ts"),
  resolve(components, "gettingStartedAiChoices.ts"),
  resolve(components, "mentionableMembers.ts"),
  resolve(components, "useChatGettingStartedState.ts"),
  resolve(components, "chat-input/ChatInput.tsx"),
  resolve(components, "__tests__/AiCredentialsStatusBubble.test.tsx"),
  resolve(components, "__tests__/ChatGettingStartedCard.test.tsx"),
  resolve(components, "__tests__/ComposerActionMenu.test.tsx"),
  resolve(components, "__tests__/ConnectChipStrip.test.tsx"),
  resolve(components, "__tests__/connectors.test.ts"),
  resolve(components, "__tests__/gettingStartedAiChoices.test.ts"),
  resolve(components, "__tests__/mentionableMembers.test.ts"),
  resolve(components, "__tests__/useChatGettingStartedState.test.tsx"),
  resolve(frontend, "tests/playwright/component/chat-getting-started-card.spec.ts"),
  resolve(frontend, "tests/playwright/smoke/chat-onboarding.spec.ts"),
  resolve(frontend, "tests/playwright/smoke/skills-import.spec.ts"),
  resolve(repo, "docs/Product.md"),
];

// Lines that are agent prompts, not labels: the assistant is asked politely
// on purpose. Everything else with "please" is a UI string and fails.
const PROMPT_LINE_ALLOWLIST = [/merge my edits into the latest workspace version/i, /get the project back to a clean state/i];

describe("first-run copy gate", () => {
  it.each(GATED_FILES.map((file) => [file.slice(repo.length + 1), file]))(
    "%s carries no em-dash",
    (_label, file) => {
      expect(existsSync(file), file).toBe(true);
      const source = readFileSync(file, "utf8");
      const offenders = source
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => line.includes("\u2014"));
      expect(offenders, offenders.map(([line, text]) => `${line}: ${text.trim()}`).join("\n")).toEqual([]);
    },
  );

  it.each(GATED_FILES.map((file) => [file.slice(repo.length + 1), file]))(
    "%s says no please to the user",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      const offenders = source
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /\bplease\b/i.test(line))
        // Tests asserting the absence of the word are not the word.
        .filter(([, line]) => !/not\.toContain\("please"\)/.test(line))
        .filter(([, line]) => !PROMPT_LINE_ALLOWLIST.some((pattern) => pattern.test(line)));
      expect(offenders, offenders.map(([line, text]) => `${line}: ${text.trim()}`).join("\n")).toEqual([]);
    },
  );
});
