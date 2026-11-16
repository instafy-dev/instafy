// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Badge } from "../../../components/Badge";
import type { ControllerTunnelGrant } from "../../../sdk/instafy";
import type { RuntimeMenuOption } from "../../useRuntimeMenu";
import { RuntimeOptionMeta } from "../RuntimeOptionMeta";
import { RuntimeTunnelDetails } from "../RuntimeTunnelDetails";

// A machine's status chip is a Badge in its tone with no colour of its own:
// Tailwind orders utilities that set the same property by name, so a colour
// class passed beside the Badge's neutral tone lost to it and the chip showed
// neutral grey.

function machineOption(badge: RuntimeMenuOption["badge"]): RuntimeMenuOption {
  return {
    id: "machine-1",
    label: "Instafy Cloud",
    detail: null,
    state: "online",
    badge,
    isSessionOverride: false,
    tunnel: null,
    needsActivation: false,
    isLikelyLocal: false,
  };
}

function tunnelGrant(status: string): ControllerTunnelGrant {
  return {
    id: "grant-1",
    projectId: null,
    runtimeId: "machine-1",
    runtimeLeaseId: null,
    provider: "test",
    tunnelId: "tunnel-1",
    hostname: "tunnel.example.dev",
    url: null,
    status,
    expiresAt: null,
  };
}

const colourClasses = (element: Element | null | undefined) =>
  (element?.getAttribute("class") ?? "")
    .split(" ")
    .filter((name) => /^(?:dark:)?(?:bg|text|border)-(?:[a-z]+-\d+|white|black|transparent)(?:\/.+)?$/.test(name));

describe("machine status chips", () => {
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

  function chipWithText(text: string) {
    return [...container.querySelectorAll("span")].find((element) => element.textContent === text);
  }

  it.each(["warning", "danger", "neutral"] as const)("draws a %s machine status in the Badge's own tone", async (tone) => {
    await act(async () => {
      root.render(
        <>
          <RuntimeOptionMeta option={machineOption({ text: "Degraded", tone })} />
          <Badge size="xs" tone={tone} data-testid="reference">Reference</Badge>
        </>,
      );
    });
    const reference = colourClasses(container.querySelector('[data-testid="reference"]'));
    expect(reference).not.toEqual([]);
    expect(colourClasses(chipWithText("Degraded"))).toEqual(reference);
  });

  it.each([
    ["refreshing", "warning", "Tunnel refreshing"],
    ["failed", "danger", "Tunnel failed"],
  ] as const)("draws a %s tunnel in the %s Badge tone", async (status, tone, text) => {
    await act(async () => {
      root.render(
        <>
          <RuntimeTunnelDetails grant={tunnelGrant(status)} statusBadgeTestId="tunnel-status" />
          <Badge size="xs" tone={tone} data-testid="reference">Reference</Badge>
        </>,
      );
    });
    const chip = container.querySelector('[data-testid="tunnel-status"]');
    expect(chip?.textContent).toBe(text);
    expect(colourClasses(chip)).toEqual(colourClasses(container.querySelector('[data-testid="reference"]')));
  });
});
