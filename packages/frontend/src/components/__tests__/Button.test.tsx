// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../Button";

const Glyph = () => <svg data-testid="glyph" aria-hidden="true" />;

describe("Button", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (node: ReactNode) => {
    await act(async () => root.render(node));
    return container.querySelector("button") as HTMLButtonElement;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["primary", "secondary", "outline", "danger"] as const)(
    "can flatten %s actions without changing their palette, targets or focus treatment",
    async (variant) => {
      const raised = await render(<Button variant={variant}>Choose</Button>);
      const raisedClasses = [...raised.classList];
      expect(raisedClasses).toContain("shadow-sm");

      const flat = await render(<Button variant={variant} elevation="none">Choose</Button>);
      const shadowClass = /(?:^|:)shadow-/;
      expect([...flat.classList]).toEqual(raisedClasses.filter((name) => !shadowClass.test(name)));
      expect(flat.hasAttribute("elevation")).toBe(false);

      const explicitRaised = await render(<Button variant={variant} elevation="raised">Choose</Button>);
      expect([...explicitRaised.classList]).toEqual(raisedClasses);
    },
  );

  it.each(["ghost", "text"] as const)("keeps %s actions flat regardless of elevation", async (variant) => {
    const raised = await render(<Button variant={variant} elevation="raised">Cancel</Button>);
    const classes = [...raised.classList];
    expect(classes.some((name) => /(?:^|:)shadow-/.test(name))).toBe(false);

    const flat = await render(<Button variant={variant} elevation="none">Cancel</Button>);
    expect([...flat.classList]).toEqual(classes);
  });

  it("renders the icon before the label while idle", async () => {
    const button = await render(<Button icon={<Glyph />}>Continue with Google</Button>);
    expect(button.firstElementChild?.getAttribute("data-testid")).toBe("glyph");
    expect(button.textContent).toBe("Continue with Google");
    expect(button.querySelector(".animate-spin")).toBeNull();
  });

  it("swaps the icon for one spinner, keeps the label and focus, and ignores presses", async () => {
    const onPress = vi.fn();
    const idle = await render(
      <Button icon={<Glyph />} onPress={onPress}>
        Continue with Google
      </Button>,
    );
    idle.focus();

    const button = await render(
      <Button icon={<Glyph />} onPress={onPress} isPending>
        Continue with Google
      </Button>,
    );

    expect(button.querySelector('[data-testid="glyph"]')).toBeNull();
    const spinners = button.querySelectorAll(".animate-spin");
    expect(spinners).toHaveLength(1);
    expect(spinners[0].getAttribute("aria-hidden")).toBe("true");
    expect(spinners[0].className).toContain("border-t-current");
    // React Aria's pending pattern: a labelled progressbar in the icon's slot,
    // so the announcement on press reads "Loading" with the label.
    const progress = button.firstElementChild;
    expect(progress?.getAttribute("role")).toBe("progressbar");
    expect(progress?.getAttribute("aria-label")).toBe("Loading");
    expect(progress?.contains(spinners[0])).toBe(true);
    expect(button.textContent).toBe("Continue with Google");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);

    await act(async () => button.click());
    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps an icon-less label in place, faded under a centred spinner", async () => {
    const button = await render(<Button isPending>Continue</Button>);
    expect(button.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(button.textContent).toBe("Continue");
    const label = [...button.querySelectorAll("span")].find((node) => node.textContent === "Continue" && node.className.includes("opacity-0"));
    expect(label).toBeDefined();
    const progress = button.querySelector('[role="progressbar"]');
    expect(progress?.className).toContain("absolute");
    expect(progress?.className).toContain("-translate-x-1/2");
  });

  it("replaces an icon button's glyph and keeps its accessible name", async () => {
    const button = await render(
      <IconButton aria-label="Remove account" isPending>
        <Glyph />
      </IconButton>,
    );
    expect(button.querySelector('[data-testid="glyph"]')).toBeNull();
    expect(button.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(button.getAttribute("aria-label")).toBe("Remove account");
  });
});
