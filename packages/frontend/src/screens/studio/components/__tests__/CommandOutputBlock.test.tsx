// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COMMAND_OUTPUT_BODY_LINE_CAP,
  COMMAND_OUTPUT_BODY_MAX_LINES,
  CommandOutputBlock,
} from "../CommandOutputBlock";

describe("CommandOutputBlock", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("can start collapsed for read-only run traces", async () => {
    await act(async () => {
      root.render(
        <CommandOutputBlock
          command="bash -lc instafy conversation create"
          output={'{\n  "conversationId": "thread-1"\n}'}
          collapsible
          defaultOutputVisible={false}
          compact
          subtle
        />,
      );
    });

    expect(container.textContent).toContain("Output hidden - expand to inspect.");
    expect(container.textContent).not.toContain('"conversationId"');

    const toggle = container.querySelector('button[aria-label="Show command output"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle?.click();
    });

    expect(container.textContent).toContain('"conversationId"');
    expect(container.querySelector('button[aria-label="Hide command output"]')).not.toBeNull();
  });

  it("renders only the output body in bodyOnly mode: no header, no controls, no frame", async () => {
    await act(async () => {
      root.render(
        <CommandOutputBlock
          command="/bin/bash -lc whoami"
          output={"marcuspousette\r\nd1d070f\n"}
          status="completed"
          bodyOnly
          onCancel={() => undefined}
        />,
      );
    });

    const block = container.querySelector<HTMLElement>('[data-testid="chat-command-output"]');
    expect(block?.getAttribute("data-body-only")).toBe("true");
    expect(block?.textContent).not.toContain("whoami");
    expect(block?.textContent).not.toContain("bash -lc");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(block?.className).not.toContain("border");
    expect(block?.className).not.toContain("rounded-xl");
    expect(block?.className).not.toContain("bg-");
    const pre = block?.querySelector("pre");
    expect(pre?.textContent).toBe("marcuspousette\nd1d070f");
    expect(pre?.className).toContain("overflow-x-auto");
    expect(pre?.className).toContain("font-mono");
    expect(pre?.className).toContain("text-slate-700");
    expect(pre?.className).toContain("dark:text-slate-200");
  });

  it("caps the bodyOnly tail at twelve lines and reveals the rest inline", async () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    await act(async () => {
      root.render(<CommandOutputBlock output={output} status="completed" bodyOnly />);
    });

    const pre = container.querySelector("pre");
    expect(pre?.textContent?.split("\n")).toHaveLength(COMMAND_OUTPUT_BODY_LINE_CAP);
    expect(pre?.textContent?.startsWith("line 9\n")).toBe(true);
    expect(pre?.textContent?.endsWith("line 20")).toBe(true);
    const showAll = container.querySelector<HTMLButtonElement>("button");
    expect(showAll?.textContent).toBe("Show all 20 lines");

    await act(async () => {
      showAll?.click();
    });
    expect(container.querySelector("pre")?.textContent).toBe(output);
    expect(container.querySelector("pre")?.className).toContain("max-h-96");
    expect(container.querySelector("button")).toBeNull();
  });

  it("resets bodyOnly show-all when a different command's output replaces the current one", async () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    await act(async () => {
      root.render(<CommandOutputBlock command="/bin/bash -lc pnpm lint" output={output} status="completed" bodyOnly />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(output);

    // Same command, more output (streaming append): show-all survives.
    await act(async () => {
      root.render(
        <CommandOutputBlock command="/bin/bash -lc pnpm lint" output={`${output}\nline 21`} status="completed" bodyOnly />,
      );
    });
    expect(container.querySelector("button")).toBeNull();

    // A later command in the same host arrives capped again.
    await act(async () => {
      root.render(<CommandOutputBlock command="/bin/bash -lc pnpm test" output={output} status="completed" bodyOnly />);
    });
    expect(container.querySelector("button")?.textContent).toBe("Show all 20 lines");
    expect(container.querySelector("pre")?.textContent?.split("\n")).toHaveLength(COMMAND_OUTPUT_BODY_LINE_CAP);
  });

  it("bounds bodyOnly show-all at the last 400 lines behind an earlier-lines note", async () => {
    const total = COMMAND_OUTPUT_BODY_MAX_LINES + 137;
    const output = Array.from({ length: total }, (_, index) => `line ${index + 1}`).join("\n");
    await act(async () => {
      root.render(<CommandOutputBlock output={output} status="completed" bodyOnly />);
    });
    expect(container.querySelector('[data-testid="chat-command-output-earlier-lines"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent?.split("\n")).toHaveLength(COMMAND_OUTPUT_BODY_LINE_CAP);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    const pre = container.querySelector("pre");
    const renderedLines = pre?.textContent?.split("\n") ?? [];
    expect(renderedLines).toHaveLength(COMMAND_OUTPUT_BODY_MAX_LINES);
    expect(renderedLines[0]).toBe("line 138");
    expect(renderedLines.at(-1)).toBe(`line ${total}`);
    expect(pre?.className).toContain("overflow-y-auto");
    expect(pre?.className).toContain("max-h-96");
    const note = container.querySelector<HTMLElement>('[data-testid="chat-command-output-earlier-lines"]');
    expect(note?.textContent).toBe("… 137 earlier lines not shown");
    expect(note?.className).toContain("text-slate-500");
    expect(note?.className).toContain("dark:text-slate-400");
    // The note sits above the tail.
    expect(note && pre ? note.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
  });

  it("streams into the bodyOnly tail while running and renders nothing for empty output", async () => {
    await act(async () => {
      root.render(<CommandOutputBlock output="" status="running" bodyOnly />);
    });
    expect(container.querySelector('[data-testid="chat-command-output"]')).toBeNull();

    await act(async () => {
      root.render(<CommandOutputBlock output={"first\n"} status="running" bodyOnly />);
    });
    const block = container.querySelector<HTMLElement>('[data-testid="chat-command-output"]');
    expect(block?.getAttribute("data-streaming")).toBe("true");
    expect(block?.textContent).toBe("first");

    await act(async () => {
      root.render(<CommandOutputBlock output={"first\nsecond\n"} status="running" bodyOnly />);
    });
    expect(container.querySelector("pre")?.textContent).toBe("first\nsecond");
  });
});
