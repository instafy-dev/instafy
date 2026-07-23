// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProviderSurfaceSandboxPage } from "../ProviderSurfaceSandboxPage";

function renderSandboxRoute(pathname: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route path="/provider-sandbox/:providerId/:surfaceId" element={<ProviderSurfaceSandboxPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProviderSurfaceSandboxPage", () => {
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

  it("renders the simulated devices sandbox view for the local-trusted settings route", () => {
    const html = renderSandboxRoute("/provider-sandbox/simulated-devices/settings_card");

    expect(html).toContain("Sandboxed provider surface");
    expect(html).toContain("Simulated Devices");
    expect(html).toContain("Desk lamp demo");
    expect(html).toContain("Turn on");
    expect(html).toContain("Refresh host state");
  });

  it("renders the simulated devices sandbox view for the local-trusted detail route", () => {
    const html = renderSandboxRoute("/provider-sandbox/simulated-devices/detail_view");

    expect(html).toContain("Sandboxed provider surface");
    expect(html).toContain("Simulated Devices");
    expect(html).toContain("Desk lamp demo");
    expect(html).toContain("Turn on");
    expect(html).toContain("Refresh host state");
  });

  it("renders the generic fallback for unknown provider sandbox routes", () => {
    const html = renderSandboxRoute("/provider-sandbox/custom-provider/detail_view");

    expect(html).toContain("Custom Provider");
    expect(html).toContain("detail view slot");
    expect(html).toContain("No provider-specific sandbox view is registered");
  });

  it("applies typed host resource deltas without waiting for a full host-state refresh", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/provider-sandbox/simulated-devices/detail_view"]}>
          <Routes>
            <Route
              path="/provider-sandbox/:providerId/:surfaceId"
              element={<ProviderSurfaceSandboxPage />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "instafy:providerSandboxHostState",
            payload: {
              version: 1,
              providerId: "simulated-devices",
              providerTitle: "Simulated devices",
              familyId: "simulated-devices",
              surfaceId: "detail_view",
              resolvedTheme: "light",
              grantedCapabilities: ["host_resources", "host_resource_deltas"],
              hostResources: [
                {
                  id: "attachment_status",
                  title: "Current attachment",
                  facts: [
                    {
                      label: "Status",
                      value: "Attached to this space",
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Attached to this space");

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "instafy:providerSandboxHostResourceDelta",
            payload: {
              stateToken: "delta-token",
              resources: [
                {
                  id: "attachment_status",
                  title: "Current attachment",
                  facts: [
                    {
                      label: "Status",
                      value: "Waiting for attachment",
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Waiting for attachment");
    expect(container.textContent).not.toContain("Attached to this space");
    expect(container.textContent).toContain("delta-to");
  });
});
