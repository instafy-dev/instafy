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
      { kind: "list", ordered: false, items: ["Inspect `TODO.md`", "Run checks"] },
      { kind: "list", ordered: true, start: 2, items: ["Second", "Third"] },
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
      parseMessageContentBlocks("3) Command output:\n```text\nmarcuspousette\nd3fdb3f\n```\n\nBOX OK"),
    ).toEqual([
      { kind: "list", ordered: true, start: 3, items: ["Command output:"] },
      { kind: "code", language: "text", lines: ["marcuspousette", "d3fdb3f"] },
      { kind: "paragraph", line: "BOX OK" },
    ]);
  });

  it("opens a fenced code block after an ordered-list item with dot delimiters", () => {
    expect(parseMessageContentBlocks("1. Command output:\n```sh\npnpm test\n```")).toEqual([
      { kind: "list", ordered: true, start: 1, items: ["Command output:"] },
      { kind: "code", language: "sh", lines: ["pnpm test"] },
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
      { kind: "list", ordered: true, start: 1, items: ["Run the check:"] },
      { kind: "code", language: "sh", lines: ["pnpm test"] },
      { kind: "list", ordered: true, start: 2, items: ["Ship it"] },
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
