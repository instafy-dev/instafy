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
