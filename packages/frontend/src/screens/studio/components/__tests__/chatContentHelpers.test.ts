import { describe, expect, it } from "vitest";
import { summarizeActiveCommandForPreview } from "../chatContentHelpers";

describe("chatContentHelpers", () => {
  it("summarizes active Instafy context recovery commands", () => {
    expect(
      summarizeActiveCommandForPreview(
        'bash -lc \'instafy conversation search "handbook guardrail" --include-threads --json\'',
      ),
    ).toBe('Searching prior chats for "handbook guardrail"…');

    expect(
      summarizeActiveCommandForPreview(
        'instafy agents context list --json --query "auth session boundaries"',
      ),
    ).toBe('Checking saved agent context for "auth session boundaries"…');
  });

  it("summarizes common shell work without dumping the full command", () => {
    expect(summarizeActiveCommandForPreview('rg -n "bigint" /workspace/project/source')).toBe(
      'Searching workspace for "bigint"…',
    );
    expect(summarizeActiveCommandForPreview("git clone https://github.com/dao-xyz/borsh-ts.git sources/borsh")).toBe(
      "Cloning source repo…",
    );
    expect(summarizeActiveCommandForPreview("pnpm test:e2e:controller")).toBe("Running tests…");
    expect(
      summarizeActiveCommandForPreview(
        "/bin/bash -lc 'bash -lc \\'rg -n \"overlap-goal\" multi-agent-smoke .agents\\''",
      ),
    ).toBe('Searching workspace for "overlap-goal"…');
    expect(
      summarizeActiveCommandForPreview(
        "/bin/bash -lc bash -lc \\'instafy conversation search \"product/workflow guardrails\" --include-threads --json\\'",
      ),
    ).toBe('Searching prior chats for "product/workflow guardrails"…');
    expect(
      summarizeActiveCommandForPreview(
        "/bin/bash -lc bash -lc \\'python - <<\"PY\"\\nfrom pathlib import Path\\nroot = Path(\".codex-runtime-fallback/sessions\")\\nPY\\'",
      ),
    ).toBe("Checking prior context…");
    expect(
      summarizeActiveCommandForPreview(
        "/bin/bash -lc set -euo pipefail\nmarker='handoff-borsh'\nif [ ! -d \"$repo_dir\" ]; then\n  git clone --depth 1 https://github.com/dao-xyz/borsh-ts \"$repo_dir\"\nfi\nfind \"$repo_dir\" -maxdepth 2 -type f",
      ),
    ).toBe("Cloning source repo…");
  });
});

describe("workspace search status", () => {
  it.each([
    ["a printf format with an escape", 'rg -n "%s\\n" src'],
    ["a tab escape", 'grep -rn "\\tTODO" .'],
    ["a regex alternation", 'rg "TODO|FIXME" packages'],
    ["regex anchors and wildcards", "rg '^import .* from' src"],
    ["a character class", 'grep -E "[0-9]+ items" notes.txt'],
    ["a call pattern", 'rg -n "useState(" src'],
    ["a numeric placeholder", 'rg "total: %d" src'],
    ["a very long phrase", 'rg -n "the quick brown fox jumps over the lazy dog again and again" docs'],
  ])("says plainly that it is searching when the pattern is %s", (_label, command) => {
    expect(summarizeActiveCommandForPreview(command)).toBe("Searching the workspace…");
  });

  it.each([
    ["a multi-line pattern", 'rg -U "first line\nsecond line" src'],
    ["a multi-line pattern with Windows line endings", 'rg -U "first line\r\nsecond line" src'],
    ["a multi-line pattern inside a shell wrapper", "bash -lc 'rg -U \"first line\n  second line\" src'"],
  ])("does not join the lines of %s into one phrase", (_label, command) => {
    expect(command).toMatch(/[\r\n]/);
    expect(summarizeActiveCommandForPreview(command)).toBe("Searching the workspace…");
  });

  it("still names a one-line pattern when the command itself spans lines", () => {
    expect(summarizeActiveCommandForPreview('cd packages &&\n  rg -n "invoice" src')).toBe('Searching workspace for "invoice"…');
  });

  it("uses the same plain status when the search has no quoted pattern", () => {
    expect(summarizeActiveCommandForPreview("rg -n TODO src")).toBe("Searching the workspace…");
  });

  it.each(["invoice", "customer name", "overlap-goal", "INSTAFY.md", "user_id", "Café menu"])(
    "keeps the readable pattern %s",
    (topic) => {
      expect(summarizeActiveCommandForPreview(`rg -n "${topic}" src`)).toBe(`Searching workspace for "${topic}"…`);
    },
  );
});

describe("command previews in the transcript", () => {
  it("never shows the raw secrets invocation, which carries the space id", () => {
    const raw = "instafy secrets list --space d6aaf12d-3d56-45da-90d3-4806e2e47c10 --json";
    const preview = summarizeActiveCommandForPreview(raw);
    expect(preview).toBe("Checking which values this space already has…");
    expect(preview).not.toContain("d6aaf12d");
    expect(preview).not.toContain("--json");
  });
});
