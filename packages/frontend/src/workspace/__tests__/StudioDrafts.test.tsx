// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioDraftsProvider, useStudioDraftSnapshot, useStudioDraftState } from "../StudioDrafts";

describe("retained identity drafts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let initial: string;
  let ready: boolean;
  let visible: boolean;
  let scope: string;
  let edit: (value: string) => void;
  let count: number;
  function Field() {
    const [value, setValue] = useStudioDraftState(scope, initial, ready);
    edit = setValue;
    return <input aria-label="Name" value={value} readOnly />;
  }
  function Page() {
    count = useStudioDraftSnapshot().drafts.length;
    return visible ? <Field /> : null;
  }
  const render = () => act(async () => root.render(<StudioDraftsProvider><Page /></StudioDraftsProvider>));
  const value = () => container.querySelector("input")?.value;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    initial = "Alex"; ready = true; visible = true; scope = "profile:a";
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("follows server refreshes without marking untouched fields dirty", async () => {
    await render(); initial = "Updated on another device"; await render();
    expect(value()).toBe(initial); expect(count).toBe(0);
    await act(async () => edit("My unfinished edit"));
    initial = "Another server refresh"; await render();
    expect(value()).toBe("My unfinished edit"); expect(count).toBe(1);
    // The server confirms a save of that edit.
    initial = "My unfinished edit"; await render();
    expect(count).toBe(0);
  });

  it("does not confuse a loading placeholder with confirmation of an intentionally cleared field", async () => {
    await render(); await act(async () => edit(""));
    visible = false; await render();
    initial = ""; ready = false; visible = true; await render();
    expect(value()).toBe(""); expect(count).toBe(1);
    initial = "Alex"; ready = true; await render();
    expect(value()).toBe(""); expect(count).toBe(1);
    await act(async () => edit(initial));
    expect(count).toBe(0);
  });

  it("keeps drafts separate when switching team or space identity", async () => {
    await render(); await act(async () => edit("Draft for A"));
    scope = "profile:b"; initial = "Blair"; await render();
    expect(value()).toBe("Blair");
    await act(async () => edit("Draft for B"));
    scope = "profile:a"; initial = "Alex"; await render();
    expect(value()).toBe("Draft for A"); expect(count).toBe(2);
  });
});
