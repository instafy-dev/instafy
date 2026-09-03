import { describe, expect, it } from "vitest";
import {
  findWorkspaceFileReferenceAt,
  parseMessageContentBlocks,
  parseTeamFlowLine,
  tokenizeChatLine,
} from "../chatMessageDialect";

describe("chatMessageDialect", () => {
  it("groups paragraphs and compact markdown-style lists into explicit blocks", () => {
    expect(parseMessageContentBlocks("Summary:\n- Inspect `TODO.md`\n- Run checks\n\n2. Second\n3. Third")).toEqual([
      { kind: "paragraph", line: "Summary:" },
      {
        kind: "list",
        ordered: false,
        items: [
          { text: "Inspect `TODO.md`", depth: 0, ordered: false },
          { text: "Run checks", depth: 0, ordered: false },
        ],
      },
      {
        kind: "list",
        ordered: true,
        start: 2,
        items: [
          { text: "Second", depth: 0, ordered: true },
          { text: "Third", depth: 0, ordered: true },
        ],
      },
    ]);
  });

  it("nests indented bulleted sublists inside an ordered list block", () => {
    expect(
      parseMessageContentBlocks(
        "1. First step\n   - detail a\n   - detail b\n2. Second step",
      ),
    ).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { text: "First step", depth: 0, ordered: true },
          { text: "detail a", depth: 1, ordered: false },
          { text: "detail b", depth: 1, ordered: false },
          { text: "Second step", depth: 0, ordered: true },
        ],
      },
    ]);
  });

  it("nests unindented bullets that directly follow an ordered item as its sublist (#191)", () => {
    // Verbatim shape of the real agent answer from the box-check thread.
    expect(
      parseMessageContentBlocks(
        [
          "1. Persistent-context skills starting with `autofix-`:",
          "- `autofix-bugfix`: land a fix",
          "- `autofix-triage`: sort reports",
          "2. First bullet under `Identity, repos, ground rules` in `AGENTS.md`:",
          "- keep the box rules",
          "3. Done.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { text: "Persistent-context skills starting with `autofix-`:", depth: 0, ordered: true },
          { text: "`autofix-bugfix`: land a fix", depth: 1, ordered: false },
          { text: "`autofix-triage`: sort reports", depth: 1, ordered: false },
          {
            text: "First bullet under `Identity, repos, ground rules` in `AGENTS.md`:",
            depth: 0,
            ordered: true,
          },
          { text: "keep the box rules", depth: 1, ordered: false },
          { text: "Done.", depth: 0, ordered: true },
        ],
      },
    ]);
  });

  it("lets indented bullets nest deeper under a flat sublist bullet", () => {
    expect(parseMessageContentBlocks("1. Step\n- detail\n  - finer detail\n- detail two\n2. Next")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { text: "Step", depth: 0, ordered: true },
          { text: "detail", depth: 1, ordered: false },
          { text: "finer detail", depth: 2, ordered: false },
          { text: "detail two", depth: 1, ordered: false },
          { text: "Next", depth: 0, ordered: true },
        ],
      },
    ]);
  });

  it("carries the flat sublist across one blank line only when the ordered item ends with a colon", () => {
    expect(parseMessageContentBlocks("1. Skills:\n\n- alpha\n- beta\n\n2. Next")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { text: "Skills:", depth: 0, ordered: true },
          { text: "alpha", depth: 1, ordered: false },
          { text: "beta", depth: 1, ordered: false },
        ],
      },
      {
        kind: "list",
        ordered: true,
        start: 2,
        items: [{ text: "Next", depth: 0, ordered: true }],
      },
    ]);
  });

  it("keeps bullets after a blank line as a sibling block when the ordered item has no trailing colon", () => {
    // Pins the boundary of the #191 leniency rule.
    expect(parseMessageContentBlocks("1. First\n\n- flat bullet")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [{ text: "First", depth: 0, ordered: true }],
      },
      {
        kind: "list",
        ordered: false,
        items: [{ text: "flat bullet", depth: 0, ordered: false }],
      },
    ]);
  });

  it("does not apply the flat-sublist leniency to ordered items after bullets", () => {
    expect(parseMessageContentBlocks("- topic:\n1. step")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [{ text: "topic:", depth: 0, ordered: false }],
      },
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [{ text: "step", depth: 0, ordered: true }],
      },
    ]);
  });

  it("still flushes a colon-terminated ordered item across a blank line before non-list content", () => {
    expect(parseMessageContentBlocks("1. Command output:\n\n```text\nok\n```")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [{ text: "Command output:", depth: 0, ordered: true }],
      },
      { kind: "code", language: "text", lines: ["ok"] },
    ]);
  });

  it("returns to the parent level when a nested sublist dedents", () => {
    expect(
      parseMessageContentBlocks("- top\n  - nested\n    - deeper\n  - nested again\n- top again"),
    ).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { text: "top", depth: 0, ordered: false },
          { text: "nested", depth: 1, ordered: false },
          { text: "deeper", depth: 2, ordered: false },
          { text: "nested again", depth: 1, ordered: false },
          { text: "top again", depth: 0, ordered: false },
        ],
      },
    ]);
  });

  it("groups markdown-style quote lines into quote blocks", () => {
    expect(parseMessageContentBlocks("> Inspect `bigint.ts:15`\n> before editing.\n\nSummarize")).toEqual([
      { kind: "quote", lines: ["Inspect `bigint.ts:15`", "before editing."] },
      { kind: "paragraph", line: "Summarize" },
    ]);
  });

  it("opens a fenced code block after an ordered-list item with paren delimiters", () => {
    expect(
      parseMessageContentBlocks("3) Command output:\n```text\nexample-user\nd3fdb3f\n```\n\nBOX OK"),
    ).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [{ text: "Command output:", depth: 0, ordered: true }],
      },
      { kind: "code", language: "text", lines: ["example-user", "d3fdb3f"], inListItem: true },
      { kind: "paragraph", line: "BOX OK" },
    ]);
  });

  it("opens a fenced code block after an ordered-list item with dot delimiters", () => {
    expect(parseMessageContentBlocks("1. Command output:\n```sh\npnpm test\n```")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [{ text: "Command output:", depth: 0, ordered: true }],
      },
      { kind: "code", language: "sh", lines: ["pnpm test"], inListItem: true },
    ]);
  });

  it("keeps list-like and quote-like lines literal inside a fenced code block", () => {
    expect(
      parseMessageContentBlocks("Before\n```\n1) not a list\n\n- not a bullet\n> not a quote\n```\nAfter"),
    ).toEqual([
      { kind: "paragraph", line: "Before" },
      { kind: "code", language: null, lines: ["1) not a list", "", "- not a bullet", "> not a quote"] },
      { kind: "paragraph", line: "After" },
    ]);
  });

  it("dedents a fenced code block indented inside a list item", () => {
    expect(
      parseMessageContentBlocks("1. Run the check:\n   ```sh\n   pnpm test\n   ```\n2. Ship it"),
    ).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [{ text: "Run the check:", depth: 0, ordered: true }],
      },
      { kind: "code", language: "sh", lines: ["pnpm test"], inListItem: true },
      {
        kind: "list",
        ordered: true,
        start: 2,
        items: [{ text: "Ship it", depth: 0, ordered: true }],
      },
    ]);
  });

  it("runs an unclosed fence to the end of the message", () => {
    expect(parseMessageContentBlocks("Output:\n```text\nstill code\n- still code")).toEqual([
      { kind: "paragraph", line: "Output:" },
      { kind: "code", language: "text", lines: ["still code", "- still code"] },
    ]);
  });

  it("keeps a triple-backtick inline code span on one line out of fence parsing", () => {
    expect(parseMessageContentBlocks("Run ```pnpm test``` now")).toEqual([
      { kind: "paragraph", line: "Run ```pnpm test``` now" },
    ]);
  });

  it("tokenizes the supported chat dialect without rendering dependencies", () => {
    const tokens = tokenizeChatLine(
      "See **Findings** in [[thread:thread-controller-123|@octo lane]], docs/README.md:12, [docs](https://example.com/docs), https://example.com/raw), @api and @octo.",
      new Set(["api"]),
    );

    expect(tokens.map((token) => token.type)).toEqual([
      "text",
      "strong",
      "text",
      "conversation-reference",
      "text",
      "workspace-file",
      "text",
      "link",
      "text",
      "link",
      "text",
      "agent-mention",
      "text",
      "assistant-mention",
      "text",
    ]);
    expect(tokens[1]).toEqual({ type: "strong", value: "Findings" });
    expect(tokens[3]).toMatchObject({
      type: "conversation-reference",
      value: {
        kind: "thread",
        conversationId: "thread-controller-123",
        label: "@octo lane",
      },
    });
    expect(tokens[5]).toMatchObject({
      type: "workspace-file",
      value: { path: "docs/README.md", raw: "docs/README.md:12", line: 12 },
    });
    expect(tokens[7]).toEqual({
      type: "link",
      value: { url: "https://example.com/docs", label: "docs" },
    });
    expect(tokens[9]).toEqual({
      type: "link",
      value: { url: "https://example.com/raw", label: "https://example.com/raw" },
    });
    expect(tokens[11]).toEqual({ type: "agent-mention", value: "@api" });
    expect(tokens[13]).toEqual({ type: "assistant-mention", value: "@octo" });
  });

  it("tokenizes GitHub PR and issue URLs into github-reference tokens without swallowing trailing punctuation", () => {
    expect(
      tokenizeChatLine("Draft PR https://github.com/instafy-dev/instafy/pull/551. Rollout tracked in https://github.com/instafy-dev/instafy/issues/173)."),
    ).toEqual([
      { type: "text", value: "Draft PR " },
      {
        type: "github-reference",
        value: {
          url: "https://github.com/instafy-dev/instafy/pull/551",
          owner: "instafy-dev",
          repo: "instafy",
          number: 551,
          kind: "pull",
        },
      },
      { type: "text", value: ". Rollout tracked in " },
      {
        type: "github-reference",
        value: {
          url: "https://github.com/instafy-dev/instafy/issues/173",
          owner: "instafy-dev",
          repo: "instafy",
          number: 173,
          kind: "issue",
        },
      },
      { type: "text", value: ")." },
    ]);
  });

  it("keeps non-GitHub URLs and GitHub URLs of other shapes as plain links", () => {
    expect(tokenizeChatLine("See https://example.com/pull/5 for details.")).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: { url: "https://example.com/pull/5", label: "https://example.com/pull/5" } },
      { type: "text", value: " for details." },
    ]);
    expect(tokenizeChatLine("Diff at https://github.com/instafy-dev/instafy/pull/551/files now.")).toEqual([
      { type: "text", value: "Diff at " },
      {
        type: "link",
        value: {
          url: "https://github.com/instafy-dev/instafy/pull/551/files",
          label: "https://github.com/instafy-dev/instafy/pull/551/files",
        },
      },
      { type: "text", value: " now." },
    ]);
    expect(tokenizeChatLine("Repo https://github.com/instafy-dev/instafy here.")).toEqual([
      { type: "text", value: "Repo " },
      {
        type: "link",
        value: { url: "https://github.com/instafy-dev/instafy", label: "https://github.com/instafy-dev/instafy" },
      },
      { type: "text", value: " here." },
    ]);
  });

  it("keeps markdown-like markers literal inside inline code", () => {
    expect(tokenizeChatLine("Keep `**literal** @octo docs/README.md:12 [docs](https://example.com)` intact.")).toEqual([
      { type: "text", value: "Keep " },
      { type: "inline-code", value: "**literal** @octo docs/README.md:12 [docs](https://example.com)" },
      { type: "text", value: " intact." },
    ]);
  });

  it("treats a standalone inline-code file path as a workspace file reference", () => {
    expect(tokenizeChatLine("Inspect `docs/README.md:12`.")).toEqual([
      { type: "text", value: "Inspect " },
      {
        type: "workspace-file",
        value: { path: "docs/README.md", raw: "docs/README.md:12", line: 12 },
      },
      { type: "text", value: "." },
    ]);
  });

  it("parses workspace file extensions that share prefixes with shorter extensions", () => {
    expect(tokenizeChatLine("Inspect `packages/rpc/package.json:7` and docs/guide.markdown:2.")).toEqual([
      { type: "text", value: "Inspect " },
      {
        type: "workspace-file",
        value: { path: "packages/rpc/package.json", raw: "packages/rpc/package.json:7", line: 7 },
      },
      { type: "text", value: " and " },
      {
        type: "workspace-file",
        value: { path: "docs/guide.markdown", raw: "docs/guide.markdown:2", line: 2 },
      },
      { type: "text", value: "." },
    ]);
  });

  it("does not let malformed truncated inline code swallow recovered evidence prose", () => {
    const tokens = tokenizeChatLine(
      "Evidence: `writeBufferLEBigInt()` pads then does `.s…. Scheduling: **Likely impact:** bad serialization. Inspected paths: `packages/borsh/src/bigint.ts`, `packages/borsh/src/index.ts:34`. Source: [[thread:abc|prior team run]].",
    );

    expect(
      tokens.some(
        (token) => token.type === "inline-code" && token.value.includes("Inspected paths"),
      ),
    ).toBe(false);
    expect(
      tokens.every((token) => token.type !== "text" || !token.value.includes("`")),
    ).toBe(true);
    expect(tokens).toContainEqual({
      type: "workspace-file",
      value: {
        path: "packages/borsh/src/bigint.ts",
        raw: "packages/borsh/src/bigint.ts",
        line: null,
      },
    });
    expect(tokens).toContainEqual({
      type: "workspace-file",
      value: {
        path: "packages/borsh/src/index.ts",
        raw: "packages/borsh/src/index.ts:34",
        line: 34,
      },
    });
    expect(tokens).toContainEqual({
      type: "conversation-reference",
      value: {
        kind: "thread",
        raw: "[[thread:abc|prior team run]]",
        conversationId: "abc",
        label: "prior team run",
      },
    });
  });

  it("normalizes absolute runtime workspace paths into workspace-relative file references", () => {
    const absolutePath =
      "/workspace/project-123/shared/final-matrix-borsh-20260531a/source/borsh-ts/packages/borsh/src/index.ts:28";

    expect(tokenizeChatLine(`Inspect \`${absolutePath}\`.`)).toEqual([
      { type: "text", value: "Inspect " },
      {
        type: "workspace-file",
        value: {
          path: "shared/final-matrix-borsh-20260531a/source/borsh-ts/packages/borsh/src/index.ts",
          raw: absolutePath,
          line: 28,
        },
      },
      { type: "text", value: "." },
    ]);
  });

  it("keeps malformed conversation references as plain text", () => {
    expect(tokenizeChatLine("Broken [[thread:|missing]] ref.")).toEqual([
      { type: "text", value: "Broken [[thread:|missing]] ref." },
    ]);
  });

  it("parses explicit workstream flow lines from conversation references only", () => {
    expect(
      parseTeamFlowLine(
        "Workstreams: [[conversation:conversation-controller-1|frontend lane]] · [[thread:thread-controller-2|@runtime lane]]",
      ),
    ).toEqual({
      label: "Workstreams",
      references: [
        {
          kind: "conversation",
          raw: "[[conversation:conversation-controller-1|frontend lane]]",
          conversationId: "conversation-controller-1",
          label: "frontend lane",
        },
        {
          kind: "thread",
          raw: "[[thread:thread-controller-2|@runtime lane]]",
          conversationId: "thread-controller-2",
          label: "@runtime lane",
        },
      ],
    });

    expect(
      parseTeamFlowLine(
        "Team: [[conversation:conversation-controller-1|frontend lane]] · [[thread:thread-controller-2|@runtime lane]]",
      )?.label,
    ).toBe("Workstreams");
    expect(parseTeamFlowLine("Team: [[thread:thread-controller-2|@runtime lane]]")).toBeNull();
    expect(
      parseTeamFlowLine(
        "Workstreams: I checked [[conversation:conversation-controller-1|frontend]] and [[thread:thread-controller-2|runtime]].",
      ),
    ).toBeNull();
    expect(
      parseTeamFlowLine(
        "The team discussed [[conversation:conversation-controller-1|frontend]] and [[thread:thread-controller-2|runtime]].",
      ),
    ).toBeNull();
  });

  it("requires token boundaries for workspace file references", () => {
    expect(findWorkspaceFileReferenceAt("beforedocs/README.md", 6)).toBeNull();
    expect(findWorkspaceFileReferenceAt("Open docs/README.md:4.", 5)).toEqual({
      end: 21,
      reference: { path: "docs/README.md", raw: "docs/README.md:4", line: 4 },
    });
    expect(findWorkspaceFileReferenceAt("(/workspace/project/docs/README.md:4)", 1)).toEqual({
      end: 36,
      reference: { path: "docs/README.md", raw: "/workspace/project/docs/README.md:4", line: 4 },
    });
  });
});
